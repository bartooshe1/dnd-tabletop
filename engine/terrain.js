// Terrain registry: a fixed list of defaults plus campaign-defined custom types.
// Each type: color (UI), glyph (UI, emoji or text, may be ""), ascii (text fallback char), blocking.
import { closest, slug } from "./fuzzy.js";

const T = (color, glyph, ascii, blocking = false) => ({ color, glyph, ascii, blocking });

export const DEFAULT_TERRAIN = {
  floor: T("#3b3f47", "", "."),
  wall: T("#8b8f98", "", "#", true),
  door: T("#9a6a3a", "🚪", "+"),
  door_locked: T("#7a4a2a", "🔒", "%", true),
  window: T("#6fa8c9", "", '"', true),
  water: T("#2f6f9f", "", "~"),
  deep_water: T("#1d4670", "", "W"),
  lava: T("#d9531e", "", "L"),
  grass: T("#3e6b35", "", ","),
  tree: T("#24472a", "🌲", "T", true),
  bush: T("#4f7d3a", "🌿", "*"),
  road: T("#8a7a5e", "", ":"),
  stairs_up: T("#5c6068", "▲", "<"),
  stairs_down: T("#4a4d55", "▼", ">"),
  ladder: T("#5c6068", "🪜", "H"),
  chest: T("#3b3f47", "🧰", "C"),
  trap: T("#3b3f47", "⚠", "^"),
  table: T("#7a5230", "", "="),
  chair: T("#3b3f47", "🪑", "h"),
  bed: T("#3b3f47", "🛏", "b"),
  bar: T("#5a3a22", "", "|", true),
  fire: T("#3b3f47", "🔥", "!"),
  rubble: T("#55524c", "🪨", ";"),
  pillar: T("#3b3f47", "⬤", "O", true),
  fence: T("#6e5a3e", "", "F", true),
  market_stall: T("#7a5a2e", "⛺", "M", true),
  barrel: T("#3b3f47", "🛢", "0", true),
  altar: T("#6d5f86", "🕯", "A", true),
  crate: T("#3b3f47", "📦", "X", true),
  rug: T("#7a2430", "", "_"),
  statue: T("#3b3f47", "🗿", "S", true),
  bookshelf: T("#5a3a22", "📚", "K", true),
  well: T("#3b3f47", "⛲", "U", true),
};

/** Common names Claude may reach for, mapped to canonical ids. */
export const TERRAIN_ALIASES = {
  stone_wall: "wall", brick_wall: "wall", wood_wall: "wall", wooden_wall: "wall", rock_wall: "wall", cliff: "wall", rock: "rubble",
  wet_floor: "floor", stone_floor: "floor", wood_floor: "floor", wooden_floor: "floor", ground: "floor", dirt: "floor", tile: "floor", tiles: "floor", flagstone: "floor", cave_floor: "floor", sand: "floor",
  door_open: "door", open_door: "door", doorway: "door", gate: "door", wooden_door: "door",
  locked_door: "door_locked", door_closed: "door_locked", portcullis: "door_locked", iron_door: "door_locked",
  glass: "window", pool: "water", river: "water", stream: "water", puddle: "water", shallow_water: "water", lake: "deep_water", sea: "deep_water", magma: "lava",
  meadow: "grass", grassland: "grass", lawn: "grass", trees: "tree", forest: "tree", pine: "tree", oak: "tree",
  shrub: "bush", hedge: "bush", undergrowth: "bush", path: "road", street: "road", trail: "road", cobblestone: "road", cobbles: "road", dirt_road: "road",
  stairs: "stairs_up", staircase: "stairs_up", upstairs: "stairs_up", downstairs: "stairs_down", steps: "stairs_up",
  coffer: "chest", trapdoor: "trap", pit: "trap", spikes: "trap", desk: "table", workbench: "table", anvil: "table",
  stool: "chair", bench: "chair", throne: "chair", bunk: "bed", cot: "bed", counter: "bar",
  campfire: "fire", fireplace: "fire", hearth: "fire", forge: "fire", brazier: "fire", torch: "fire",
  boulder: "rubble", rocks: "rubble", debris: "rubble", stones: "rubble", column: "pillar", railing: "fence", stall: "market_stall",
  cask: "barrel", keg: "barrel", shrine: "altar", sarcophagus: "altar", coffin: "altar", box: "crate", crates: "crate",
  carpet: "rug", tapestry: "rug", idol: "statue", bookcase: "bookshelf", shelf: "bookshelf", fountain: "well",
};

/** Merge defaults with campaign custom types (custom wins). */
export function terrainTable(custom = {}) {
  return { ...DEFAULT_TERRAIN, ...custom };
}

/** Resolve a name to a canonical terrain id, or null. */
export function resolveTerrain(name, custom = {}) {
  const table = terrainTable(custom);
  const s = slug(name);
  if (table[s]) return s;
  if (TERRAIN_ALIASES[s]) return TERRAIN_ALIASES[s];
  const singular = s.replace(/(es|s)$/, "");
  if (singular !== s && (table[singular] || TERRAIN_ALIASES[singular])) return table[singular] ? singular : TERRAIN_ALIASES[singular];
  if (s.endsWith("s") && table[s.slice(0, -1)]) return s.slice(0, -1);
  return null;
}

/**
 * Does an unknown name look like a terrain attempt? (e.g. "wetfloor", "stonewall", "flor").
 * Used to raise an "unknown terrain" error instead of silently placing a creature token.
 */
export function looksLikeTerrain(name, custom = {}) {
  const s = slug(name).replace(/_/g, "");
  if (s.length < 3) return false;
  const words = [...Object.keys(terrainTable(custom)), ...Object.keys(TERRAIN_ALIASES)].map((w) => w.replace(/_/g, ""));
  return words.some(
    (w) =>
      w.length >= 4 &&
      (s.startsWith(w) || s.endsWith(w) || (Math.abs(w.length - s.length) <= 2 && editDistanceAtMost(s, w, 2))),
  );
}

function editDistanceAtMost(a, b, k) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n] <= k;
}

/** Near matches for an unknown terrain name (canonical ids). */
export function terrainSuggestions(name, custom = {}) {
  const table = terrainTable(custom);
  const pool = [...Object.keys(table), ...Object.keys(TERRAIN_ALIASES)];
  const hits = closest(name, pool, 6).map((h) => (table[h] ? h : TERRAIN_ALIASES[h]));
  return [...new Set(hits)].slice(0, 3);
}

/** Compact one-line listing for the `types` command. */
export function listTypes(custom = {}) {
  const fmt = (id, t) => `${id}${t.blocking ? "*" : ""}`;
  const defaults = Object.entries(DEFAULT_TERRAIN)
    .filter(([id]) => !custom[id])
    .map(([id, t]) => fmt(id, t));
  const mine = Object.entries(custom).map(([id, t]) => fmt(id, t));
  return `terrain (*=blocks): ${defaults.join(" ")}${mine.length ? ` | custom: ${mine.join(" ")}` : ""}`;
}
