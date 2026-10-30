// Where the engine finds its bundled resources. Everything is relative to the folder that holds
// engine/ (or, in the esbuild bundle, the folder that holds the bundle's parent), so the same
// code works from the repo, the .mcpb and the Claude Code plugin.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = process.env.DND_RESOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url));
export const DATA_DIR = path.join(ROOT, "data");
export const LAYOUT_DIR = path.join(ROOT, "layouts");
export const TEMPLATE_DIR = path.join(ROOT, "templates");
export const UI_DIR = path.join(ROOT, "build", "ui");
