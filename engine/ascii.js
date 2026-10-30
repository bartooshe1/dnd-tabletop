// ASCII <-> grid conversion, used by `draw`, built-in layouts and the text fallback.
import { DEFAULT_TERRAIN, resolveTerrain, terrainTable } from "./terrain.js";
import { slug } from "./fuzzy.js";

/** The documented default legend for `draw`. Everything else needs a legend entry. */
export const DEFAULT_LEGEND = { "#": "wall", ".": "floor", "+": "door", "@": "player", " ": "nothing" };
const NOTHING = new Set(["nothing", "none", "empty", "void", "null"]);

/** Every terrain type's own ascii char (used by built-in layouts and the text fallback). */
export function fullLegend(custom = {}) {
  const legend = {};
  for (const [id, t] of Object.entries(terrainTable(custom))) if (t.ascii) legend[t.ascii] = id;
  return { ...legend, ...DEFAULT_LEGEND };
}

/**
 * Convert ASCII rows to a terrain grid plus token placements.
 * Legend values may be terrain types, "nothing", or creature types/ids.
 * Returns { cols, rows, terrain, tokens: [{ r, c, what }], base, errors: [string] }.
 */
export function gridFromRows(lines, legend, custom = {}) {
  const chars = lines.map((l) => Array.from(l));
  const rows = chars.length;
  const cols = Math.max(0, ...chars.map((l) => l.length));
  const terrain = [];
  const tokens = [];
  const unknown = new Map();
  const resolved = {};
  for (const [ch, value] of Object.entries(legend)) {
    const v = slug(value);
    if (NOTHING.has(v)) resolved[ch] = { terrain: null };
    else {
      const t = resolveTerrain(v, custom);
      resolved[ch] = t ? { terrain: t } : { token: v };
    }
  }
  const counts = {};
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const ch = chars[r][c] ?? " ";
      const hit = resolved[ch];
      if (!hit) {
        if (!unknown.has(ch)) unknown.set(ch, `${r + 1}x${c + 1}`);
        row.push(null);
      } else if (hit.token) {
        tokens.push({ r, c, what: hit.token });
        row.push(undefined); // filled with the base terrain below
      } else {
        row.push(hit.terrain);
        if (hit.terrain && !terrainTable(custom)[hit.terrain]?.blocking) counts[hit.terrain] = (counts[hit.terrain] ?? 0) + 1;
      }
    }
    terrain.push(row);
  }
  const base = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "floor";
  for (const row of terrain) for (let c = 0; c < row.length; c++) if (row[c] === undefined) row[c] = base;
  const errors = [...unknown].map(([ch, at]) => `unknown char '${ch}' (first at ${at}); add a legend entry like ${ch === "=" ? "?" : ch}=type`);
  return { cols, rows, terrain, tokens, base, errors };
}

/**
 * Render a map as ASCII. Returns { legend: "~=water a=wolf1", rows: [string] } where the
 * legend lists every char not in the default draw legend, so `draw` can read it back.
 */
export function toAscii(map, campaign) {
  const table = terrainTable(campaign.types);
  const charOf = {};
  const used = new Set(Object.keys(DEFAULT_LEGEND));
  for (const [id, t] of Object.entries(table)) {
    if (t.ascii && !used.has(t.ascii) && !Object.values(charOf).includes(t.ascii)) charOf[id] = t.ascii;
  }
  for (const [ch, id] of Object.entries(DEFAULT_LEGEND)) if (DEFAULT_TERRAIN[id]) charOf[id] = ch;
  const legend = {};
  const pool = [..."abcdefghijklmnopqrstuvwxyz123456789ABCDEFGIJNPQRVYZ&$?/()[]{}<>"];
  const takeChar = () => {
    const taken = new Set([...Object.values(charOf), ...Object.keys(legend), ...Object.keys(DEFAULT_LEGEND)]);
    return pool.find((ch) => !taken.has(ch));
  };
  const tokenChar = {};
  const rows = map.terrain.map((row, r) =>
    row
      .map((tid, c) => {
        const id = map.tokens[r][c];
        if (id) {
          if (!tokenChar[id]) {
            const isLonePlayer = id === "player1" && campaign.tokens[id]?.type === "player";
            tokenChar[id] = isLonePlayer ? "@" : takeChar();
            if (!isLonePlayer) legend[tokenChar[id]] = id;
          }
          return tokenChar[id];
        }
        if (tid === null) return " ";
        if (!charOf[tid]) charOf[tid] = takeChar();
        const ch = charOf[tid];
        if (!DEFAULT_LEGEND[ch]) legend[ch] = tid;
        return ch;
      })
      .join(""),
  );
  return { legend: Object.entries(legend).map(([ch, v]) => `${ch}=${v}`).join(" "), rows };
}
