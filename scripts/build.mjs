// Build: bundle both UIs into single self-contained HTML files, then (unless --ui-only)
// stage a clean bundle with production deps, validate and pack dist/dnd-tabletop-<version>.mcpb.
import fs from "node:fs";
import path from "node:path";
import { ROOT, bundleHtml, stageAndPack, productionPackage } from "./pack-lib.mjs";

const uiOnly = process.argv.includes("--ui-only");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
  throw new Error(`manifest.json version ${manifest.version} != package.json version ${pkg.version}`);
}

const outDir = path.join(ROOT, "build", "ui");
fs.mkdirSync(outDir, { recursive: true });
const TITLES = { map: "D&D map", dice: "D&D dice", play: "D&D Tabletop" };
for (const name of ["map", "dice", "play"]) {
  const html = await bundleHtml({
    entry: path.join(ROOT, "ui", name, "main.js"),
    css: path.join(ROOT, "ui", name, `${name}.css`),
    title: TITLES[name],
  });
  fs.writeFileSync(path.join(outDir, `${name}.html`), html);
  process.stderr.write(`ui ${name}.html ${(html.length / 1024).toFixed(0)} KB\n`);
}

if (!uiOnly) {
  const files = {
    "manifest.json": path.join(ROOT, "manifest.json"),
    "server": path.join(ROOT, "server"),
    "engine": path.join(ROOT, "engine"),
    "build/ui": outDir,
    "data": path.join(ROOT, "data"),
    "layouts": path.join(ROOT, "layouts"),
    "templates": path.join(ROOT, "templates"),
    "LICENSE": path.join(ROOT, "LICENSE"),
    "README.md": path.join(ROOT, "README.md"),
  };
  if (fs.existsSync(path.join(ROOT, "icon.png"))) files["icon.png"] = path.join(ROOT, "icon.png");
  const out = stageAndPack({
    stageDir: path.join(ROOT, "dist", "stage"),
    files,
    pkg: productionPackage(pkg),
    outFile: path.join(ROOT, "dist", `${pkg.name}-${pkg.version}.mcpb`),
  });
  process.stderr.write(`built ${out}\n`);
}
