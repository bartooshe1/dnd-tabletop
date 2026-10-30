#!/usr/bin/env node
// Entry for the Stop hook command (bundled to plugin/dist/stop-hook.mjs).
import { main } from "./stop-hook.js";

try {
  main();
} catch (e) {
  // never break the user's session over the game hook: allow the stop
  process.stderr.write(`[dnd-tabletop hook] ${e.message}\n`);
}
