// Builds dist/dnd-tabletop-spike-0.0.1.mcpb
import fs from "node:fs";
import path from "node:path";
import { ROOT, bundleHtml, stageAndPack, productionPackage } from "../scripts/pack-lib.mjs";

const here = path.join(ROOT, "spike");
const html = await bundleHtml({ entry: path.join(here, "ui.js"), css: path.join(here, "ui.css"), title: "D&D spike" });
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8"));

const out = stageAndPack({
  stageDir: path.join(ROOT, "dist", "stage-spike"),
  files: {
    "manifest.json": path.join(here, "manifest.json"),
    "server/server.js": path.join(here, "server.js"),
    "server/spike.html": { text: html },
  },
  pkg: { ...productionPackage(rootPkg), name: manifest.name, version: manifest.version },
  outFile: path.join(ROOT, "dist", `${manifest.name}-${manifest.version}.mcpb`),
});
process.stderr.write(`built ${out}\n`);
