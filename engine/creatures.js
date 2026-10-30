// Creature library lookup. Creature names are open: anything not in the library still works
// and renders as a colored circle with its first two letters.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";
import { slug } from "./fuzzy.js";

const FILE = path.join(DATA_DIR, "creatures.json");
const AGE = /^(young|adult|ancient|elder|greater|lesser|baby)_|_(wyrmling|boss|chief|leader|captain|archer|warrior|shaman|scout)$/;

let library = null;
function lib() {
  if (!library) {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    delete raw._format;
    library = raw;
  }
  return library;
}

export const PLAYER = { glyph: "🧑", color: "#3b82f6", side: "player" };

/** Library entry for a creature type, trying common prefixes/suffixes and first/last word. */
export function creatureInfo(type) {
  if (type === "player") return PLAYER;
  const L = lib();
  const s = slug(type);
  const tries = [s, s.replace(AGE, ""), s.replace(AGE, "").replace(AGE, ""), s.split("_")[0], s.split("_").at(-1)];
  for (const t of tries) {
    const e = L[t];
    if (e) return { glyph: e[0], color: e[1], side: e[2] ?? "hostile", known: t === s };
  }
  return null;
}

export function isKnownCreature(type) {
  return type === "player" || !!lib()[slug(type)];
}

export function creatureNames() {
  return Object.keys(lib());
}

/** Deterministic fallback color for unknown creature names. */
export function fallbackColor(type) {
  let h = 0;
  for (const ch of type) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 45% 42%)`;
}
