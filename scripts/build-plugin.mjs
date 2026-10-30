// Assemble the Claude Code plugin in plugin/: esbuild bundles (no npm install for users) plus
// the data files the engine reads at runtime. The result is committed; CI runs --check, which
// rebuilds into a temp folder and fails if the committed plugin/ differs.
// Usage: node scripts/build-plugin.mjs [--check]   (run `npm run build:ui` first)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { ROOT } from "./pack-lib.mjs";

const check = process.argv.includes("--check");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8"));
const ccVersion = /export const VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, "cc", "server.js"), "utf8"))?.[1];
if (pluginJson.version !== pkg.version || ccVersion !== pkg.version) {
  throw new Error(`versions differ: package.json ${pkg.version}, plugin.json ${pluginJson.version}, cc/server.js ${ccVersion}`);
}
const play = path.join(ROOT, "build", "ui", "play.html");
if (!fs.existsSync(play)) throw new Error("build/ui/play.html missing: run npm run build:ui first");

const out = check ? fs.mkdtempSync(path.join(os.tmpdir(), "dnd-plugin-check-")) : path.join(ROOT, "plugin");
const GENERATED = ["dist", "data", "layouts", "templates", "build"];

// CJS dependencies inside an ESM bundle need a real `require` for Node built-ins.
const banner = { js: 'import { createRequire as __dndCreateRequire } from "node:module";\nconst require = __dndCreateRequire(import.meta.url);' };
async function bundle(entry, file) {
  await build({
    entryPoints: [path.join(ROOT, entry)],
    outfile: path.join(out, "dist", file),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    minify: true,
    legalComments: "none",
    banner,
    logLevel: "silent",
  });
}

if (!check) for (const g of GENERATED) fs.rmSync(path.join(out, g), { recursive: true, force: true });
await bundle("cc/index.js", "server.mjs");
await bundle("cc/stop-hook-main.js", "stop-hook.mjs");
for (const d of ["data", "layouts"]) fs.cpSync(path.join(ROOT, d), path.join(out, d), { recursive: true });
fs.mkdirSync(path.join(out, "templates"), { recursive: true });
for (const f of ["campaign.md", "house_rules.base.md", "house_rules.cc.md"]) fs.copyFileSync(path.join(ROOT, "templates", f), path.join(out, "templates", f));
fs.mkdirSync(path.join(out, "build", "ui"), { recursive: true });
fs.copyFileSync(play, path.join(out, "build", "ui", "play.html"));

function files(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]));
}

if (check) {
  const committed = path.join(ROOT, "plugin");
  const bad = [];
  for (const g of GENERATED) {
    const want = fs.existsSync(path.join(out, g)) ? files(path.join(out, g)).map((f) => path.join(g, f)) : [];
    const have = fs.existsSync(path.join(committed, g)) ? files(path.join(committed, g)).map((f) => path.join(g, f)) : [];
    for (const f of new Set([...want, ...have])) {
      const a = path.join(out, f);
      const b = path.join(committed, f);
      if (!fs.existsSync(a) || !fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b))) bad.push(f);
    }
  }
  fs.rmSync(out, { recursive: true, force: true });
  if (bad.length) {
    process.stderr.write(`plugin/ is out of date (${bad.length} files), e.g. ${bad.slice(0, 5).join(", ")}.\nRun: npm run build:plugin and commit plugin/\n`);
    process.exit(1);
  }
  process.stderr.write("plugin/ is up to date\n");
} else {
  const size = (f) => `${(fs.statSync(path.join(out, "dist", f)).size / 1024).toFixed(0)} KB`;
  process.stderr.write(`plugin built: dist/server.mjs ${size("server.mjs")}, dist/stop-hook.mjs ${size("stop-hook.mjs")}\n`);
}
