// Campaign data model. Everything here is plain JSON so it can be cloned and persisted as-is.
//
// campaign = { version, active, maps: [Map], tokens: { id: Token }, types: { id: TerrainType }, dice: [Roll], meta, init? }
// init     = { round, current: tokenId, order: [{ id, n }] } (combat turn order, highest first)
// meta     = { startedAt, startedStamp, sceneAt, storyLogAt } (session bookkeeping)
// Map      = { name, cols, rows, scale (meters per square), caption, base, terrain: [[id|null]], tokens: [[id|null]] }
// Token    = { id, type, side, name?, hp?, maxHp?, status: [], color?, glyph? }
// Tokens live at campaign level so the player keeps HP and status across scenes;
// each map grid only references token ids.

export const MAX_SIZE = 60;
export const DEFAULT_COLS = 16;
export const DEFAULT_ROWS = 12;
export const DEFAULT_SCALE = 1.5;
export const SIDES = ["player", "ally", "neutral", "hostile"];
export const DICE_HISTORY = 200;

export function emptyCampaign() {
  return { version: 1, active: null, maps: [], tokens: {}, types: {}, dice: [], meta: {} };
}

export function grid(rows, cols, fill = null) {
  return Array.from({ length: rows }, () => Array(cols).fill(fill));
}

export function createMap(name, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, { scale = DEFAULT_SCALE, base = "floor" } = {}) {
  return {
    name,
    cols,
    rows,
    scale,
    caption: "",
    base,
    terrain: grid(rows, cols, base),
    tokens: grid(rows, cols, null),
  };
}

export function findMap(campaign, name) {
  const n = String(name).toLowerCase();
  return campaign.maps.find((m) => m.name.toLowerCase() === n) ?? null;
}

export function activeMap(campaign) {
  return campaign.active ? findMap(campaign, campaign.active) : null;
}

/** Map of tokenId -> { map, r, c } (0-based) over every map. */
export function tokenPositions(campaign) {
  const pos = new Map();
  for (const map of campaign.maps) {
    map.tokens.forEach((row, r) =>
      row.forEach((id, c) => {
        if (id) pos.set(id, { map, r, c });
      }),
    );
  }
  return pos;
}

export function findToken(map, id) {
  for (let r = 0; r < map.rows; r++) {
    const c = map.tokens[r].indexOf(id);
    if (c !== -1) return { r, c };
  }
  return null;
}

export const typeOfId = (id) => id.replace(/\d+$/, "");

/** Lowest free number for a token type, e.g. wolf1, wolf2... */
export function nextId(campaign, type, reserved = new Set()) {
  for (let n = 1; ; n++) {
    const id = `${type}${n}`;
    if (!campaign.tokens[id] && !reserved.has(id)) return id;
  }
}

/** "4x8" for 0-based (r, c). */
export const cellName = (r, c) => `${r + 1}x${c + 1}`;

/** Chebyshev distance in squares (5e default: diagonals count as one square). */
export const squares = (a, b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c));

export function uniqueMapName(campaign, wanted) {
  if (!findMap(campaign, wanted)) return wanted;
  for (let n = 2; ; n++) if (!findMap(campaign, `${wanted} ${n}`)) return `${wanted} ${n}`;
}

export const FT_PER_M = 10 / 3; // D&D convention: 1.5 m == 5 ft

export function fmtDist(meters, units) {
  if (units === "imperial") return `${Math.round(meters * FT_PER_M * 10) / 10} ft`;
  return `${Math.round(meters * 10) / 10} m`;
}
