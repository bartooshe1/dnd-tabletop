// Shared build helpers: bundle a UI entry into one self-contained HTML string,
// and stage + pack an .mcpb with production dependencies only.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Bundle `entry` (JS) and optional `css` file into a single HTML document string. */
export async function bundleHtml({ entry, css, title }) {
  const js = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2020"],
    minify: true,
    legalComments: "none",
    logLevel: "silent",
  });
  const script = js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const style = css ? fs.readFileSync(css, "utf8") : "";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${title}</title>
<style>${style}</style></head>
<body><div id="app"></div><script>${script}</script></body></html>
`;
}

function npmCli() {
  // Under `npm run`, npm_execpath points at npm-cli.js; otherwise look next to this node binary.
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((p) => p && p.endsWith(".js") && fs.existsSync(p));
}

function npm(args, cwd) {
  const cli = npmCli();
  if (cli) {
    execFileSync(process.execPath, [cli, ...args], { cwd, stdio: "inherit" });
  } else {
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  }
}

function mcpb(args) {
  const pkgDir = path.join(ROOT, "node_modules", "@anthropic-ai", "mcpb");
  const bin = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).bin;
  const cli = path.join(pkgDir, typeof bin === "string" ? bin : Object.values(bin)[0]);
  execFileSync(process.execPath, [cli, ...args], { stdio: "inherit" });
}

/**
 * Stage `files` ({ dest: srcPath | { text } }) into `stageDir`, install production
 * deps from `pkg`, validate and pack the manifest. Returns the .mcpb path.
 */
export function stageAndPack({ stageDir, files, pkg, outFile }) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  for (const [dest, src] of Object.entries(files)) {
    const target = path.join(stageDir, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (typeof src === "string") fs.cpSync(src, target, { recursive: true });
    else fs.writeFileSync(target, src.text);
  }
  fs.writeFileSync(path.join(stageDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  npm(["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts"], stageDir);
  mcpb(["validate", path.join(stageDir, "manifest.json")]);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.rmSync(outFile, { force: true });
  mcpb(["pack", stageDir, outFile]);
  return outFile;
}

/** package.json for the staged bundle: runtime dependencies only. */
export function productionPackage(rootPkg) {
  return {
    name: rootPkg.name,
    version: rootPkg.version,
    private: true,
    type: "module",
    license: rootPkg.license,
    dependencies: rootPkg.dependencies,
  };
}
