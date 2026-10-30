// What leaves the server: UI payloads (via _meta, never in model context) and text fallbacks.
// Non-player tokens carry wound words only. Their HP numbers never go into a UI payload.
import { terrainTable } from "./terrain.js";
import { creatureInfo, fallbackColor } from "./creatures.js";
import { woundWord } from "./wounds.js";
import { cellName, fmtDist } from "./model.js";
import { toAscii } from "./ascii.js";

export const VIEW_KEY = "dnd-tabletop/view";

function tokenLook(t) {
  const info = creatureInfo(t.type);
  return {
    glyph: t.glyph ?? info?.glyph ?? null,
    color: t.color ?? info?.color ?? fallbackColor(t.type),
  };
}

/** UI payload for one token. Only side=player gets HP numbers. */
export function tokenView(t, r, c) {
  const out = { id: t.id, type: t.type, side: t.side, r, c, ...tokenLook(t), status: [...(t.status ?? [])] };
  if (t.name) out.name = t.name;
  if (t.side === "player") {
    if (typeof t.hp === "number") out.hp = t.hp;
    if (typeof t.maxHp === "number") out.maxHp = t.maxHp;
  } else {
    const w = woundWord(t.hp, t.maxHp);
    if (w) out.wound = w;
  }
  return out;
}

export function buildMapView(campaign, map, { units }) {
  const view = { v: 1, kind: "map", at: Date.now(), units, maps: campaign.maps.length };
  if (!map) return { ...view, empty: true };
  const table = terrainTable(campaign.types);
  const palette = [];
  const index = new Map();
  const terrain = map.terrain.map((row) =>
    row.map((tid) => {
      if (tid === null) return -1;
      if (!index.has(tid)) {
        const t = table[tid] ?? { color: "#555", glyph: "?", blocking: false };
        index.set(tid, palette.length);
        palette.push({ id: tid, color: t.color, glyph: t.glyph ?? "", blocking: !!t.blocking });
      }
      return index.get(tid);
    }),
  );
  const tokens = [];
  map.tokens.forEach((row, r) =>
    row.forEach((id, c) => {
      const t = id && campaign.tokens[id];
      if (t) tokens.push(tokenView(t, r, c));
    }),
  );
  const init = initView(campaign);
  return { ...view, name: map.name, cols: map.cols, rows: map.rows, scale: map.scale, caption: map.caption ?? "", palette, terrain, tokens, ...(init ? { init } : {}) };
}

/** Turn order for the UI: same privacy as tokens (wound words for everyone but the player). */
export function initView(campaign) {
  const init = campaign.init;
  if (!init?.order?.length) return null;
  const order = init.order
    .filter((e) => campaign.tokens[e.id])
    .map((e) => {
      const { r, c, ...t } = tokenView(campaign.tokens[e.id], 0, 0);
      return { ...t, n: e.n };
    });
  return { round: init.round, current: init.current, order };
}

/** For Claude: "initiative round 2: player1 17, wolf1 12*" (* = whose turn it is). */
export function initText(campaign) {
  const init = campaign.init;
  if (!init?.order?.length) return null;
  return `initiative round ${init.round}: ${init.order.map((e) => `${e.id} ${e.n}${e.id === init.current ? "*" : ""}`).join(", ")}`;
}

const SIDE_ORDER = { player: 0, ally: 1, neutral: 2, hostile: 3 };

/** For Claude (DM screen): every token with real numbers, player first. */
export function tokenListText(campaign, map) {
  const found = [];
  map.tokens.forEach((row, r) => row.forEach((id, c) => id && campaign.tokens[id] && found.push({ t: campaign.tokens[id], r, c })));
  found.sort((a, b) => (SIDE_ORDER[a.t.side] ?? 9) - (SIDE_ORDER[b.t.side] ?? 9));
  const parts = found.map(({ t, r, c }) => {
    const bits = [t.id];
    if (t.name) bits.push(`'${t.name}'`);
    bits.push(cellName(r, c));
    if (t.side !== "hostile" && t.side !== "player") bits.push(t.side);
    if (typeof t.hp === "number") bits.push(`${t.hp}/${t.maxHp ?? "?"}`);
    if (t.status?.length) bits.push(t.status.join("+"));
    return bits.join(" ");
  });
  const init = initText(campaign);
  return `${parts.length ? `tokens: ${parts.join("; ")}` : "tokens: none"}${init ? `
${init}` : ""}`;
}

function scaleText(map, units) {
  return `1 sq = ${fmtDist(map.scale, units)}`;
}

export function shownLine(map, units) {
  return `shown: ${map.name} ${map.cols}x${map.rows}, ${scaleText(map, units)}`;
}

/** Full text rendering for hosts without MCP Apps: rulers, ASCII rows, legend, tokens with wound words. */
export function mapText(campaign, map, units) {
  const { legend, rows } = toAscii(map, campaign);
  const width = map.cols;
  const tens = "    " + Array.from({ length: width }, (_, c) => (c + 1 >= 10 ? Math.floor((c + 1) / 10) % 10 : " ")).join("");
  const ones = "    " + Array.from({ length: width }, (_, c) => (c + 1) % 10).join("");
  const body = rows.map((row, r) => `${String(r + 1).padStart(3)} ${row}`);
  const tokens = [];
  map.tokens.forEach((row, r) =>
    row.forEach((id, c) => {
      const t = id && campaign.tokens[id];
      if (!t) return;
      const hp = t.side === "player" ? (typeof t.hp === "number" ? ` ${t.hp}/${t.maxHp ?? "?"}` : "") : woundWord(t.hp, t.maxHp) ? ` ${woundWord(t.hp, t.maxHp)}` : "";
      tokens.push(`${t.name ? `${t.name} (${t.id})` : t.id} ${cellName(r, c)}${hp}${t.status?.length ? ` ${t.status.join("+")}` : ""}`);
    }),
  );
  return [
    `${map.name} ${map.cols}x${map.rows} (W×H), ${scaleText(map, units)}${map.caption ? ` — ${map.caption}` : ""}`,
    width >= 10 ? tens : null,
    ones,
    ...body,
    `legend: # wall . floor + door @ player1${legend ? ` ${legend}` : ""}`,
    tokens.length ? `tokens: ${tokens.join("; ")}` : null,
    initText(campaign),
  ]
    .filter((l) => l !== null)
    .join("\n");
}
