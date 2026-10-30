// Executes parsed map commands against a COPY of the campaign. Batches are atomic:
// on any error the caller keeps the original campaign and gets every error back.
import { parse } from "./parser.js";
import {
  MAX_SIZE, DEFAULT_COLS, DEFAULT_ROWS, SIDES,
  activeMap, cellName, createMap, findMap, findToken, fmtDist, FT_PER_M, grid, nextId, squares, tokenPositions, typeOfId, uniqueMapName,
} from "./model.js";
import { listTypes, looksLikeTerrain, resolveTerrain, terrainSuggestions, terrainTable } from "./terrain.js";
import { creatureInfo } from "./creatures.js";
import { closest, fuzzyPick, slug } from "./fuzzy.js";
import { DEFAULT_LEGEND, gridFromRows } from "./ascii.js";
import { generate, GENERATORS, MIN_GEN } from "./generators.js";
import { woundWord } from "./wounds.js";

const SIDE_ALIASES = { enemy: "hostile", foe: "hostile", monster: "hostile", friend: "ally", friendly: "ally", party: "ally", npc: "neutral", pc: "player" };

class CmdError extends Error {
  constructor(reason, hint) {
    super(reason);
    this.hint = hint;
  }
}
const fail = (reason, hint) => {
  throw new CmdError(reason, hint);
};

/**
 * Run `text` against `campaign` (not mutated).
 * ctx: { units: "metric"|"imperial", detail: "lean"|"detailed", rooms: RoomStore, random: () => number }
 * Returns { ok: true, campaign, info: [string], effects: [..] } or { ok: false, errors: [string] }.
 */
export function execute(campaign, text, ctx) {
  const parsed = parse(text);
  if (!parsed.length) return { ok: false, errors: ["no commands given"] };
  const errors = parsed.filter((p) => p.error).map((p) => fmtError(p.index, p.src, p.error, p.hint));
  const state = { c: structuredClone(campaign), info: [], effects: [], events: [], removed: new Set(), ctx, detailed: ctx.detail === "detailed" };
  for (const p of parsed) {
    if (p.error) continue;
    try {
      run(state, p.cmd);
    } catch (e) {
      if (!(e instanceof CmdError)) throw e;
      errors.push(fmtError(p.index, p.src, e.message, e.hint));
    }
  }
  if (errors.length) return { ok: false, errors };
  finalizeRemovals(state);
  return { ok: true, campaign: state.c, info: state.info, effects: state.effects, events: state.events };
}

function fmtError(index, src, reason, hint) {
  const short = src.length > 40 ? src.slice(0, 37) + "..." : src;
  return `#${index} '${short.replace(/\n/g, " ")}': ${reason}${hint ? ` (${hint})` : ""}`;
}

// ---------- helpers ----------

/**
 * Player-safe event for the session log: never a non-player HP number.
 * kind "scene" marks a scene change (new map, switch, replacing load, gen, draw).
 */
function event(state, kind, text) {
  state.events.push({ kind, text });
}

function ensureMap(state) {
  let map = activeMap(state.c);
  if (!map) {
    map = createMap(uniqueMapName(state.c, "Map 1"), DEFAULT_COLS, DEFAULT_ROWS);
    state.c.maps.push(map);
    state.c.active = map.name;
    state.info.push(`created map '${map.name}' ${map.cols}x${map.rows}`);
  }
  return map;
}

function sizeText(map) {
  return `map is ${map.cols}x${map.rows} W×H: rows 1-${map.rows}, cols 1-${map.cols}`;
}

function checkCell(map, cell) {
  if (cell.r < 0 || cell.c < 0 || cell.r >= map.rows || cell.c >= map.cols) {
    fail(`${cellName(cell.r, cell.c)} is off the map`, sizeText(map));
  }
}

function checkSize(size, what = "map") {
  if (!size) fail(`${what} needs a size`, "size is WxH, e.g. 16x12");
  if (size.cols < 1 || size.rows < 1 || size.cols > MAX_SIZE || size.rows > MAX_SIZE) {
    fail(`size ${size.cols}x${size.rows} not allowed`, `max ${MAX_SIZE}x${MAX_SIZE}`);
  }
}

function tokenAt(map, r, c) {
  return map.tokens[r][c];
}

function removeTokenFromGrid(state, id) {
  for (const map of state.c.maps) {
    const at = findToken(map, id);
    if (at) map.tokens[at.r][at.c] = null;
  }
}

function clearMapTokens(state, map) {
  for (let r = 0; r < map.rows; r++)
    for (let c = 0; c < map.cols; c++) {
      if (map.tokens[r][c]) state.removed.add(map.tokens[r][c]);
    }
  map.tokens = grid(map.rows, map.cols, null);
}

/** At the end of a batch, delete tokens that left the board, except players and allies. */
function finalizeRemovals(state) {
  const onBoard = tokenPositions(state.c);
  for (const id of state.removed) {
    const t = state.c.tokens[id];
    if (t && !onBoard.has(id) && t.side !== "player" && t.side !== "ally") delete state.c.tokens[id];
  }
  const init = state.c.init;
  if (init) for (const e of [...init.order]) if (!state.c.tokens[e.id]) dropInit(init, e.id);
}

// ---------- initiative ----------
// campaign.init = { round, current: tokenId, order: [{ id, n }] } (highest first), or absent.

const who = (state, id) => state.c.tokens[id]?.name || id;

/** Remove an entry; if it was its turn, the next one in order gets it. */
function dropInit(init, id) {
  const i = init.order.findIndex((e) => e.id === id);
  if (i === -1) return false;
  init.order.splice(i, 1);
  if (init.current === id) {
    if (i >= init.order.length) init.round++;
    init.current = init.order.length ? init.order[i % init.order.length].id : null;
  }
  return true;
}

function runInit(state, cmd) {
  const c = state.c;
  if (cmd.action === "end") {
    if (c.init) event(state, "init", "combat over");
    delete c.init;
    return;
  }
  if (cmd.action === "next") {
    const init = c.init;
    if (!init?.order.length) fail("no initiative order", "set it first: init player1=17 wolf1=12");
    const i = init.order.findIndex((e) => e.id === init.current);
    const next = (i + 1) % init.order.length;
    if (next === 0) init.round++;
    init.current = init.order[next].id;
    state.info.push(`round ${init.round}: ${init.current}'s turn`);
    event(state, "init", `round ${init.round}: ${who(state, init.current)}'s turn`);
    return;
  }
  const fresh = !c.init;
  const init = (c.init ??= { round: 1, current: null, order: [] });
  for (const raw of cmd.remove) {
    const id = resolveTokenId(state, activeMap(c), raw);
    if (!dropInit(init, id)) fail(`${id} is not in the initiative order`, `order: ${init.order.map((e) => e.id).join(", ") || "empty"}`);
  }
  for (const { id: raw, n } of cmd.set) {
    const id = resolveTokenId(state, activeMap(c), raw);
    const e = init.order.find((x) => x.id === id);
    if (e) e.n = n;
    else init.order.push({ id, n });
  }
  // highest first; ties keep the order they were given in (Array.prototype.sort is stable)
  init.order.sort((a, b) => b.n - a.n);
  if (fresh || !init.order.some((e) => e.id === init.current)) init.current = init.order[0]?.id ?? null;
  if (!init.order.length) delete c.init;
  else {
    const order = init.order.map((e) => `${e.id} ${e.n}`).join(", ");
    state.info.push(`${fresh ? "initiative" : "order"}: ${order}; ${init.current}'s turn`);
    event(state, "init", `${fresh ? "initiative" : "order"}: ${init.order.map((e) => `${who(state, e.id)} ${e.n}`).join(", ")}`);
  }
}

function blocking(state, tid) {
  return !!(tid && terrainTable(state.c.types)[tid]?.blocking);
}

function newToken(state, id, type) {
  const info = creatureInfo(type);
  const side = type === "player" ? "player" : info?.side ?? "hostile";
  const t = { id, type, side, status: [] };
  state.c.tokens[id] = t;
  return t;
}

/**
 * Resolve what a placement of `what` means: an existing token id, a new explicit id,
 * or a bare type that needs an id. Player and ally types reuse a token that is not on this map.
 */
function tokenForPlacement(state, map, what, force) {
  const tokens = state.c.tokens;
  if (tokens[what]) return { id: what, existing: true };
  const explicit = /\d$/.test(what);
  const type = explicit ? typeOfId(what) : what;
  if (!type) fail(`'${what}' is not a valid token name`, "token types start with a letter, e.g. wolf");
  if (!force && type !== "player" && !creatureInfo(type) && looksLikeTerrain(type, state.c.types)) {
    const near = terrainSuggestions(type, state.c.types);
    fail(
      `unknown terrain '${type}'${near.length ? `, closest: ${near.join(", ")}` : ""}`,
      `to add: type ${type} glyph=💧 color=#4a6; for a creature named that, write ${type}!`,
    );
  }
  if (explicit) return { id: what, type, created: true };
  // reuse a player/ally of this type that is off the board or on another map
  const onThisMap = new Set(map.tokens.flat().filter(Boolean));
  const reusable = Object.values(tokens)
    .filter((t) => t.type === type && (t.side === "player" || t.side === "ally") && !onThisMap.has(t.id))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  if (reusable.length) return { id: reusable[0].id, existing: true, auto: true };
  return { id: nextId(state.c, type), type, created: true, auto: true };
}

function placeToken(state, map, r, c, what, force) {
  const occupant = tokenAt(map, r, c);
  const pick = tokenForPlacement(state, map, what, force);
  if (occupant && occupant !== pick.id) fail(`${cellName(r, c)} has ${occupant}`, `clear it first (${cellName(r, c)}-empty) or pick another cell`);
  if (pick.created) newToken(state, pick.id, pick.type);
  else {
    const here = findToken(map, pick.id);
    if (here && !pick.auto && (here.r !== r || here.c !== c)) {
      fail(`${pick.id} is already at ${cellName(here.r, here.c)}`, `to move it: ${pick.id} > ${cellName(r, c)}`);
    }
    removeTokenFromGrid(state, pick.id);
  }
  map.tokens[r][c] = pick.id;
  state.removed.delete(pick.id);
  event(state, "token", `${pick.id} placed at ${cellName(r, c)}`);
  if (pick.auto) state.info.push(`${pick.id} ${cellName(r, c)}`);
  else if (state.detailed) state.info.push(`placed ${pick.id} ${cellName(r, c)}`);
  if (blocking(state, map.terrain[r][c])) state.info.push(`note: ${pick.id} stands on ${map.terrain[r][c]} at ${cellName(r, c)}`);
  return pick;
}

function resolveTokenId(state, map, raw) {
  const id = slug(raw);
  const tokens = state.c.tokens;
  if (tokens[id]) return id;
  const ofType = Object.values(tokens).filter((t) => t.type === id);
  const onMap = map ? ofType.filter((t) => findToken(map, t.id)) : [];
  if (onMap.length === 1) return onMap[0].id;
  if (!onMap.length && ofType.length === 1) return ofType[0].id;
  const near = closest(id, Object.keys(tokens), 3);
  const many = (onMap.length > 1 ? onMap : ofType).map((t) => t.id);
  fail(`no token '${id}'`, many.length > 1 ? `which one: ${many.join(", ")}` : near.length ? `closest: ${near.join(", ")}` : "place one first, e.g. 4x3-wolf");
}

function nearbyTokens(map, cell) {
  const list = [];
  map.tokens.forEach((row, r) => row.forEach((id, c) => id && list.push({ id, r, c, d: squares({ r, c }, cell) })));
  return list
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((t) => `${t.id} at ${cellName(t.r, t.c)}`)
    .join(", ");
}

/** Copy a layout/room/generated grid onto a map, either replacing it or embedding at an offset. */
function applyGrid(state, map, layout, at) {
  if (!at) {
    clearMapTokens(state, map);
    map.cols = layout.cols;
    map.rows = layout.rows;
    map.terrain = layout.terrain.map((row) => [...row]);
    map.tokens = grid(map.rows, map.cols, null);
    map.base = layout.base ?? map.base ?? "floor";
    if (layout.scale) map.scale = layout.scale;
    for (const t of layout.tokens ?? []) placeLayoutToken(state, map, t.r, t.c, t);
    return;
  }
  const fits = at.r >= 0 && at.c >= 0 && at.r + layout.rows <= map.rows && at.c + layout.cols <= map.cols;
  if (!fits) {
    fail(
      `${layout.name ?? "room"} (${layout.cols}x${layout.rows}) at ${cellName(at.r, at.c)} doesn't fit`,
      `${sizeText(map)}; it needs rows ${at.r + 1}-${at.r + layout.rows}, cols ${at.c + 1}-${at.c + layout.cols}`,
    );
  }
  for (let r = 0; r < layout.rows; r++)
    for (let c = 0; c < layout.cols; c++) {
      const tid = layout.terrain[r][c];
      if (tid !== null) map.terrain[at.r + r][at.c + c] = tid;
    }
  for (const t of layout.tokens ?? []) placeLayoutToken(state, map, at.r + t.r, at.c + t.c, t);
}

function placeLayoutToken(state, map, r, c, t) {
  // A saved id is reused if it is free (or was just cleared off this map); players always reuse.
  const recycled = !!t.id && !!state.c.tokens[t.id] && state.removed.has(t.id) && !tokenPositions(state.c).has(t.id);
  const free = !!t.id && (!state.c.tokens[t.id] || recycled);
  const what = free && t.type !== "player" ? t.id : t.type;
  const pick = placeToken(state, map, r, c, slug(what), true);
  if (!pick.created && !(recycled && pick.id === t.id)) return;
  const tok = state.c.tokens[pick.id];
  for (const k of ["side", "name", "hp", "maxHp", "color", "glyph"]) if (t[k] !== undefined) tok[k] = t[k];
  tok.status = [...(t.status ?? [])];
}

// ---------- token properties ----------

function applyHp(tok, value) {
  const v = String(value).trim();
  let m;
  if ((m = /^(\d+)\s*\/\s*(\d+)$/.exec(v))) {
    tok.hp = Number(m[1]);
    tok.maxHp = Number(m[2]);
  } else if ((m = /^\/\s*(\d+)$/.exec(v))) {
    tok.maxHp = Number(m[1]);
    if (tok.hp === undefined || tok.hp > tok.maxHp) tok.hp = tok.maxHp;
  } else if ((m = /^([+-])\s*(\d+)$/.exec(v))) {
    if (tok.hp === undefined) fail(`${tok.id} has no hp yet`, `set it first: tok ${tok.id} hp=7/7`);
    tok.hp += (m[1] === "+" ? 1 : -1) * Number(m[2]);
  } else if ((m = /^(\d+)$/.exec(v))) {
    tok.hp = Number(m[1]);
    if (tok.maxHp === undefined) tok.maxHp = tok.hp;
  } else fail(`bad hp '${v}'`, "hp=7/7 (cur/max), hp=5, hp=-3 or hp=+4");
  if (tok.maxHp !== undefined) tok.hp = Math.max(0, Math.min(tok.hp, tok.maxHp));
  return /^[+-]/.test(v);
}

function applyStatus(tok, value) {
  const items = String(value).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (items.length === 1 && ["none", "clear", "-"].includes(items[0])) return (tok.status = []);
  const set = items.some((i) => !/^[+-]/.test(i)) ? [] : [...tok.status];
  for (const item of items) {
    const name = item.replace(/^[+-]/, "").replace(/_/g, " ");
    const i = set.indexOf(name);
    if (item.startsWith("-")) {
      if (i !== -1) set.splice(i, 1);
    } else if (i === -1) set.push(name);
  }
  tok.status = set;
}

// ---------- commands ----------

function run(state, cmd) {
  const { c } = state;
  switch (cmd.op) {
    case "place": {
      const map = ensureMap(state);
      checkCell(map, cmd.from);
      checkCell(map, cmd.to);
      const what = cmd.what;
      const terrain = !cmd.force && what !== "empty" && what !== "clear" ? resolveTerrain(what, c.types) : null;
      const cells = (cmd.to.r - cmd.from.r + 1) * (cmd.to.c - cmd.from.c + 1);
      const isTokenPlace = what !== "empty" && what !== "clear" && !terrain;
      if (isTokenPlace && cells > 1 && (c.tokens[what] || /\d$/.test(what))) {
        fail(`can't put one token (${what}) in ${cells} cells`, `use the bare type to fill a range, e.g. ${cellName(cmd.from.r, cmd.from.c)}..${cellName(cmd.to.r, cmd.to.c)}-${typeOfId(what)}`);
      }
      if (isTokenPlace && cells > 40) fail(`${cells} tokens is too many for one range`, "max 40 per range");
      for (let r = cmd.from.r; r <= cmd.to.r; r++)
        for (let col = cmd.from.c; col <= cmd.to.c; col++) {
          if (what === "empty") {
            const id = tokenAt(map, r, col);
            if (id) {
              map.tokens[r][col] = null;
              state.removed.add(id);
              event(state, "token", `${id} removed from ${cellName(r, col)}`);
            } else map.terrain[r][col] = map.base ?? "floor";
          } else if (what === "clear") {
            const id = tokenAt(map, r, col);
            if (id) {
              state.removed.add(id);
              event(state, "token", `${id} removed from ${cellName(r, col)}`);
            }
            map.tokens[r][col] = null;
            map.terrain[r][col] = null;
          } else if (terrain) map.terrain[r][col] = terrain;
          else placeToken(state, map, r, col, what, cmd.force);
        }
      return;
    }
    case "move": {
      const map = ensureMap(state);
      let from;
      let id;
      if (cmd.from.id) {
        id = resolveTokenId(state, map, cmd.from.id);
        from = findToken(map, id);
        if (!from) {
          const other = c.maps.find((m) => findToken(m, id));
          fail(`${id} is not on this map${other ? ` (it's on '${other.name}')` : ""}`, `place it here: ${cellName(cmd.to.r, cmd.to.c)}-${id}`);
        }
      } else {
        checkCell(map, cmd.from);
        from = cmd.from;
        id = tokenAt(map, from.r, from.c);
        if (!id) {
          const near = nearbyTokens(map, from);
          fail(`no token at ${cellName(from.r, from.c)}`, near ? `tokens nearby: ${near}` : "the map has no tokens");
        }
      }
      checkCell(map, cmd.to);
      const { r, c: col } = cmd.to;
      const occupant = tokenAt(map, r, col);
      if (occupant && occupant !== id) fail(`${cellName(r, col)} has ${occupant}`, "pick a free cell");
      const tid = map.terrain[r][col];
      if (blocking(state, tid) && !cmd.force) fail(`${cellName(r, col)} is ${tid} (blocks movement)`, `use >! to force: ${id} >! ${cellName(r, col)}`);
      map.tokens[from.r][from.c] = null;
      map.tokens[r][col] = id;
      event(state, "token", `${id} moved ${cellName(from.r, from.c)}→${cellName(r, col)}`);
      if (state.detailed) {
        const d = squares(from, cmd.to) * map.scale;
        state.info.push(`${id} ${cellName(from.r, from.c)}→${cellName(r, col)} ${fmtDist(d, state.ctx.units)}`);
      }
      return;
    }
    case "new": {
      if (findMap(c, cmd.name)) fail(`map '${cmd.name}' already exists`, `switch with: use "${cmd.name}"`);
      const size = cmd.size ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
      checkSize(size);
      const map = createMap(cmd.name, size.cols, size.rows);
      c.maps.push(map);
      c.active = map.name;
      event(state, "scene", `new scene '${map.name}' ${map.cols}x${map.rows}`);
      return;
    }
    case "use": {
      const pick = fuzzyPick(cmd.name, c.maps, (m) => [m.name]);
      if (!pick.item) fail(`no map '${cmd.name}'`, c.maps.length ? `maps: ${c.maps.map((m) => m.name).join(", ")}` : `create one: new "${cmd.name}" 16x12`);
      if (c.active !== pick.item.name) event(state, "scene", `scene '${pick.item.name}'`);
      c.active = pick.item.name;
      if (slug(pick.item.name) !== slug(cmd.name)) state.info.push(`using '${pick.item.name}'`);
      return;
    }
    case "maps": {
      state.info.push(c.maps.length ? `maps: ${c.maps.map((m) => `${m.name}${m.name === c.active ? "*" : ""} ${m.cols}x${m.rows}`).join(", ")}` : "maps: none");
      return;
    }
    case "caption": {
      ensureMap(state).caption = cmd.text.slice(0, 300);
      if (cmd.text) event(state, "caption", `caption: ${cmd.text.slice(0, 300)}`);
      return;
    }
    case "scale": {
      const meters = state.ctx.units === "imperial" ? cmd.value / FT_PER_M : cmd.value;
      if (meters < 0.1 || meters > 1000) fail("scale out of range", "use 0.1 to 1000");
      ensureMap(state).scale = Math.round(meters * 1000) / 1000;
      event(state, "scale", `scale ${fmtDist(meters, state.ctx.units)} per square`);
      return;
    }
    case "tok": {
      const map = activeMap(c);
      const id = resolveTokenId(state, map, cmd.id);
      const tok = c.tokens[id];
      const out = [];
      for (const [key, value] of Object.entries(cmd.props)) {
        switch (key) {
          case "name":
            tok.name = String(value).slice(0, 40);
            break;
          case "hp":
            if (applyHp(tok, value) || state.detailed) out.push(`hp ${tok.hp}/${tok.maxHp ?? "?"}`);
            break;
          case "max":
          case "maxhp":
            applyHp(tok, `/${value}`);
            break;
          case "status":
          case "cond":
          case "conditions":
            applyStatus(tok, value);
            break;
          case "side": {
            const s = SIDE_ALIASES[String(value).toLowerCase()] ?? String(value).toLowerCase();
            if (!SIDES.includes(s)) fail(`bad side '${value}'`, "side=player|ally|neutral|hostile");
            tok.side = s;
            break;
          }
          case "color":
            if (!/^#[0-9a-f]{3,8}$/i.test(value) && !/^[a-z]+$/i.test(value)) fail(`bad color '${value}'`, "color=#c33");
            tok.color = value;
            break;
          case "glyph":
            tok.glyph = Array.from(String(value)).slice(0, 4).join("");
            break;
          default:
            fail(`unknown token property '${key}'`, "name= hp= status= side= color= glyph=");
        }
      }
      if (out.length) state.info.push(`${id} ${out.join(" ")}`);
      const keys = Object.keys(cmd.props);
      const said = [];
      if (keys.includes("name")) said.push(`named ${tok.name}`);
      if (keys.some((k) => ["hp", "max", "maxhp"].includes(k))) {
        // the player's own HP is a number; everyone else only ever shows a wound word
        said.push(tok.side === "player" ? `HP ${tok.hp}/${tok.maxHp ?? "?"}` : `looks ${woundWord(tok.hp, tok.maxHp) ?? "?"}`);
      }
      if (keys.some((k) => ["status", "cond", "conditions"].includes(k))) said.push(`status ${tok.status.join(", ") || "none"}`);
      if (keys.includes("side")) said.push(`side ${tok.side}`);
      if (said.length) event(state, "token", `${id} ${said.join("; ")}`);
      return;
    }
    case "type": {
      if (!cmd.id || /^\d/.test(cmd.id)) fail(`bad type name '${cmd.id}'`, "letters and underscores, e.g. wetfloor");
      const prev = terrainTable(c.types)[cmd.id];
      const t = { color: prev?.color ?? "#777777", glyph: prev?.glyph ?? "", ascii: prev?.ascii ?? "", blocking: prev?.blocking ?? false };
      for (const [key, value] of Object.entries(cmd.props)) {
        if (key === "color") {
          if (!/^#[0-9a-f]{3,8}$/i.test(value)) fail(`bad color '${value}'`, "color=#4a6");
          t.color = value;
        } else if (key === "glyph") t.glyph = Array.from(String(value)).slice(0, 4).join("");
        else if (key === "blocking" || key === "blocks") t.blocking = /^(1|true|yes|on)$/i.test(value);
        else if (key === "ascii" || key === "char") t.ascii = Array.from(String(value))[0] ?? "";
        else fail(`unknown type property '${key}'`, "glyph= color= blocking");
      }
      if (cmd.blocking !== undefined) t.blocking = cmd.blocking;
      c.types[cmd.id] = t;
      return;
    }
    case "types":
      state.info.push(listTypes(c.types));
      return;
    case "draw": {
      const legend = { ...DEFAULT_LEGEND, ...cmd.legend };
      const g = gridFromRows(cmd.rows, legend, c.types);
      if (g.errors.length) fail(g.errors.join("; "), "default legend: # wall, . floor, + door, @ player, space = nothing");
      checkSize({ cols: g.cols, rows: g.rows }, "drawing");
      let map = activeMap(c);
      if (!map) {
        map = createMap(uniqueMapName(c, "Map 1"), g.cols, g.rows);
        c.maps.push(map);
        c.active = map.name;
        state.info.push(`created map '${map.name}' ${g.cols}x${g.rows}`);
      }
      applyGrid(state, map, { ...g, tokens: [] }, null);
      event(state, "scene", `drew '${map.name}' ${g.cols}x${g.rows}`);
      for (const t of g.tokens) placeToken(state, map, t.r, t.c, t.what, false);
      return;
    }
    case "load": {
      const room = state.ctx.rooms.find(cmd.name);
      if (!room.item) {
        const names = room.candidates?.map((r) => r.id).join(", ");
        fail(`no room '${cmd.name}'`, names ? `closest: ${names}; list with rooms` : "list with rooms");
      }
      const layout = room.item;
      let map = activeMap(c);
      if (!map) {
        map = createMap(uniqueMapName(c, layout.name), layout.cols, layout.rows);
        c.maps.push(map);
        c.active = map.name;
        if (cmd.at) state.info.push(`created map '${map.name}'`);
      }
      if (cmd.at) checkCell(map, cmd.at);
      event(state, cmd.at ? "room" : "scene", cmd.at ? `loaded room ${layout.id} at ${cellName(cmd.at.r, cmd.at.c)}` : `loaded room ${layout.id} into '${map.name}'`);
      applyGrid(state, map, layout, cmd.at);
      if (state.detailed) state.info.push(`loaded ${layout.id} ${layout.cols}x${layout.rows}`);
      return;
    }
    case "rooms":
      state.info.push(state.ctx.rooms.listText());
      return;
    case "save": {
      const map = activeMap(c);
      if (!map) fail("no map to save", 'make one first: new "Name" 16x12');
      const id = slug(cmd.name);
      if (!id) fail("save needs a name with letters or digits", 'save "The Midnight Inn"');
      const tokens = [];
      if (cmd.withTokens) {
        map.tokens.forEach((row, r) =>
          row.forEach((tid, col) => {
            if (!tid) return;
            const t = c.tokens[tid];
            const { hp, maxHp, ...rest } = t;
            tokens.push({ r, c: col, ...(t.side === "player" ? { type: t.type, side: t.side } : { ...rest, hp, maxHp }) });
          }),
        );
      }
      const room = {
        id,
        name: cmd.name,
        description: map.caption || `saved from '${map.name}'`,
        cols: map.cols,
        rows: map.rows,
        scale: map.scale,
        base: map.base,
        terrain: map.terrain.map((row) => [...row]),
        tokens,
      };
      try {
        state.ctx.rooms.stage(room);
      } catch (e) {
        fail(e.message, e.hint);
      }
      state.effects.push({ kind: "saveRoom", room });
      state.info.push(`saved ${id}`);
      event(state, "room", `saved room '${cmd.name}'`);
      return;
    }
    case "init":
      return runInit(state, cmd);
    case "gen": {
      if (!GENERATORS.includes(cmd.kind)) {
        const near = closest(cmd.kind, GENERATORS, 1);
        fail(`unknown generator '${cmd.kind}'`, `kinds: ${GENERATORS.join(", ")}${near.length ? `; did you mean ${near[0]}?` : ""}`);
      }
      const { cols, rows } = cmd.size;
      if (cols < MIN_GEN || rows < MIN_GEN) fail(`gen ${cmd.kind} needs at least ${MIN_GEN}x${MIN_GEN}`, `e.g. gen ${cmd.kind} ${Math.max(cols, 10)}x${Math.max(rows, 10)}`);
      checkSize(cmd.size, "generator");
      const seed = cmd.opts.seed !== undefined ? Number(cmd.opts.seed) : Math.floor(state.ctx.random() * 1e6);
      if (!Number.isInteger(seed)) fail(`bad seed '${cmd.opts.seed}'`, "seed is a whole number");
      let out;
      try {
        out = generate(cmd.kind, cols, rows, { ...cmd.opts, seed });
      } catch (e) {
        fail(e.message, e.hint);
      }
      let map = activeMap(c);
      if (!map) {
        map = createMap(uniqueMapName(c, cmd.kind[0].toUpperCase() + cmd.kind.slice(1)), cols, rows);
        c.maps.push(map);
        c.active = map.name;
      }
      event(state, "scene", `generated ${cmd.kind} ${cols}x${rows} (seed ${seed}) in '${map.name}'`);
      applyGrid(state, map, { cols, rows, terrain: out.terrain, base: out.base, tokens: [] }, null);
      state.info.push(`seed ${seed}; ${out.features}`);
      return;
    }
    default:
      fail(`unsupported command '${cmd.op}'`);
  }
}
