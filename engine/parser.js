// Pure parser for the `map` command language. No state, no I/O.
//
// parse(text) -> [{ index, src, cmd } | { index, src, error, hint? }]
// Cells come back 0-based: { r, c }.
import { closest, slug } from "./fuzzy.js";

const KEYWORDS = ["new", "use", "maps", "caption", "scale", "tok", "type", "types", "draw", "load", "rooms", "save", "gen", "init"];
const CELL = String.raw`\d+\s*x\s*\d+`;
const ID = String.raw`[a-z_][a-z0-9_]*`;
const START = new RegExp(String.raw`^\s*(?:${CELL}|${ID}\s*>|(?:${KEYWORDS.join("|")})(?![a-z0-9_]))`, "i");
const PLACE = new RegExp(String.raw`^(${CELL})(?:\s*\.\.\s*(${CELL}))?\s*-\s*(.+)$`, "i");
const MOVE = new RegExp(String.raw`^(${CELL}|${ID})\s*>\s*(!?)\s*(${CELL})$`, "i");
const LEGEND_LINE = /^\s*(\S=[a-z_][a-z0-9_]*\s*)+$/iu;

export function parseCell(s) {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(s).trim());
  return m ? { r: Number(m[1]) - 1, c: Number(m[2]) - 1 } : null;
}

export function parseSize(s) {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(s).trim());
  return m ? { cols: Number(m[1]), rows: Number(m[2]) } : null;
}

/** Split on any char in `seps` outside double quotes; keeps the separator that ended each piece. */
function splitQuoted(line, seps) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && seps.includes(ch)) {
      out.push({ text: cur, sep: ch });
      cur = "";
    } else cur += ch;
  }
  out.push({ text: cur, sep: "" });
  return out;
}

/**
 * Break raw input into command strings. Separators: , ; newline. After a caption or a
 * tok/type/init, a comma piece that isn't itself a command stays part of it (`status=prone,poisoned`).
 * `draw` consumes the following lines up to a blank line as its rows.
 */
export function splitCommands(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const cmds = [];
  for (let i = 0; i < lines.length; i++) {
    const pieces = splitQuoted(lines[i], ",;");
    const merged = [];
    for (const p of pieces) {
      const prev = merged[merged.length - 1];
      // A comma piece that isn't a valid command continues a caption or a tok/type value list.
      const glue =
        prev &&
        prev.sep === "," &&
        p.text.trim() &&
        ((/^\s*caption\b/i.test(prev.text) && (!START.test(p.text) || parseOne(p.text).error)) ||
          (/^\s*(tok|type|init)\b/i.test(prev.text) && !START.test(p.text)));
      if (glue) {
        prev.text += prev.sep + p.text;
        prev.sep = p.sep;
      } else merged.push({ ...p });
    }
    const parts = merged.map((p) => p.text.trim()).filter(Boolean);
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      if (/^draw(?![a-z0-9_])/i.test(part)) {
        if (j !== parts.length - 1) {
          cmds.push({ src: part, drawError: "draw must be the last command on its line; put the rows on the next lines" });
          continue;
        }
        const rows = [];
        while (i + 1 < lines.length && lines[i + 1].trim() !== "") rows.push(lines[++i].replace(/\s+$/, ""));
        cmds.push({ src: part, rows });
      } else cmds.push({ src: part });
    }
  }
  return cmds;
}

/** key=value pairs ("quoted values" allowed) plus bare flags. Keys lowercased. */
export function parseProps(s) {
  const props = {};
  const flags = [];
  const re = /([a-z_]+)\s*=\s*("([^"]*)"|\S+)|(\S+)/gi;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) props[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[2];
    else flags.push(m[4].toLowerCase());
  }
  return { props, flags };
}

const unquote = (s) => s.trim().replace(/^"(.*)"$/, "$1").trim();

function hintFor(src) {
  const s = src.trim();
  let m;
  if ((m = /^(\d+\s*x\s*\d+)\s+([a-z_]\S*)$/i.exec(s))) return `write ${m[1]}-${m[2]}`;
  if ((m = /^(?:move\s+)?(\S+)\s+(?:to\s+)(\d+\s*x\s*\d+)$/i.exec(s))) return `write ${m[1]} > ${m[2]}`;
  if (/^\(?\d+\s*[,:]\s*\d+/.test(s) || /^\(?\d+\)?(\s|-|$)/.test(s)) return "cells are RxC, e.g. 4x3 (row 4, column 3)";
  if (/^\d+\s*x\s*\d+\s*(->|=>|to)\s*\d+\s*x\s*\d+$/i.test(s)) return "move with >, e.g. 4x3 > 4x8";
  const head = s.split(/\s+/)[0].toLowerCase();
  const near = closest(head, KEYWORDS, 1);
  if (near.length && near[0] !== head) return `did you mean '${near[0]}'?`;
  return "e.g. 4x3-wolf, 4x3 > 4x8, tok wolf1 hp=5/11";
}

function parseOne(src, rows) {
  const s = src.trim();
  const head = (/^[a-z]+/i.exec(s)?.[0] ?? "").toLowerCase();
  const rest = s.slice(head.length).trim();
  let m;

  if ((m = MOVE.exec(s))) {
    const from = parseCell(m[1]) ?? { id: slug(m[1]) };
    return { op: "move", from, to: parseCell(m[3]), force: m[2] === "!" };
  }
  if ((m = PLACE.exec(s))) {
    let what = m[3].trim();
    if (what.startsWith(">")) return { error: "can't read this move", hint: `write ${m[1]} > ${what.slice(1).trim()}` };
    const force = what.endsWith("!");
    if (force) what = what.slice(0, -1);
    const a = parseCell(m[1]);
    const b = m[2] ? parseCell(m[2]) : a;
    const name = slug(what);
    if (!name) return { error: "missing type after '-'", hint: "e.g. 4x3-wall or 4x3-wolf" };
    return {
      op: "place",
      from: { r: Math.min(a.r, b.r), c: Math.min(a.c, b.c) },
      to: { r: Math.max(a.r, b.r), c: Math.max(a.c, b.c) },
      range: !!m[2],
      what: name,
      force,
    };
  }

  switch (head) {
    case "new": {
      m = /^(?:"([^"]+)"|(\S+))(?:\s+(\d+\s*x\s*\d+))?$/i.exec(rest);
      if (!m) return { error: "new needs a name", hint: 'new "Crypt" 16x12 (size is WxH)' };
      return { op: "new", name: (m[1] ?? m[2]).trim(), size: m[3] ? parseSize(m[3]) : null };
    }
    case "use":
      if (!rest) return { error: "use needs a map name", hint: 'use "Crypt"' };
      return { op: "use", name: unquote(rest) };
    case "maps":
    case "types":
    case "rooms":
      if (rest) break;
      return { op: head };
    case "caption":
      return { op: "caption", text: unquote(rest) };
    case "scale": {
      const v = Number(rest.replace(/\s*(m|ft|feet|meters?)$/i, ""));
      if (!(v > 0)) return { error: "scale needs a positive number", hint: "scale 1.5 (meters per square; feet if imperial)" };
      return { op: "scale", value: v };
    }
    case "tok": {
      m = /^(\S+)\s*(.*)$/.exec(rest);
      if (!m) return { error: "tok needs a token id", hint: "tok wolf1 hp=5/11 status=prone" };
      const { props, flags } = parseProps(m[2]);
      if (flags.length) return { error: `unexpected '${flags[0]}'`, hint: "use key=value, e.g. name=Snik hp=7/7" };
      return { op: "tok", id: slug(m[1]), props };
    }
    case "type": {
      m = /^(\S+)\s*(.*)$/.exec(rest);
      if (!m) return { error: "type needs a name", hint: "type wetfloor glyph=💧 color=#4a6 blocking" };
      const { props, flags } = parseProps(m[2]);
      const bad = flags.find((f) => f !== "blocking");
      if (bad) return { error: `unexpected '${bad}'`, hint: "type wetfloor glyph=💧 color=#4a6 blocking" };
      return { op: "type", id: slug(m[1]), props, blocking: flags.includes("blocking") ? true : undefined };
    }
    case "draw": {
      const legend = {};
      let legendText = rest;
      if (!legendText && rows?.length && LEGEND_LINE.test(rows[0])) legendText = rows.shift().trim();
      for (const entry of legendText.split(/\s+/).filter(Boolean)) {
        const lm = /^(.)=(.+)$/u.exec(entry);
        if (!lm) return { error: `bad legend entry '${entry}'`, hint: "legend like ~=water T=table w=wolf" };
        legend[lm[1]] = slug(lm[2]);
      }
      if (!rows?.length) return { error: "draw has no rows", hint: "put ASCII rows on the lines after draw, end with a blank line" };
      return { op: "draw", legend, rows };
    }
    case "load": {
      m = /^(.+?)(?:\s+at\s+(\d+\s*x\s*\d+))?$/i.exec(rest);
      if (!m) return { error: "load needs a room name", hint: "load tavern or load tavern at 3x3; list with rooms" };
      return { op: "load", name: unquote(m[1]), at: m[2] ? parseCell(m[2]) : null };
    }
    case "save": {
      m = /^(.+?)(\s+with\s+tokens)?$/i.exec(rest);
      if (!m || !unquote(m[1])) return { error: "save needs a name", hint: 'save "The Midnight Inn" [with tokens]' };
      return { op: "save", name: unquote(m[1]), withTokens: !!m[2] };
    }
    case "init": {
      // init next | init end | init player1=17 wolf1=12 -goblin2 (set, add or remove entries)
      const words = rest.toLowerCase();
      if (/^(next|end|clear|stop|done)$/.test(words)) return { op: "init", action: words === "next" ? "next" : "end" };
      const set = [];
      const remove = [];
      for (const w of words.replace(/\s*[=:]\s*/g, "=").split(/[\s,]+/).filter(Boolean)) {
        if ((m = /^-([a-z_][a-z0-9_]*)$/.exec(w))) remove.push(m[1]);
        else if ((m = /^([a-z_][a-z0-9_]*)=(-?\d{1,3})$/.exec(w))) set.push({ id: m[1], n: Number(m[2]) });
        else return { error: `can't read '${w}' in init`, hint: "init player1=17 wolf1=12 | init next | init -wolf1 | init end" };
      }
      if (!set.length && !remove.length) return { error: "init needs entries", hint: "init player1=17 wolf1=12 (initiative totals), then init next" };
      return { op: "init", action: "set", set, remove };
    }
    case "gen": {
      m = /^([a-z_]+)\s+(\d+\s*x\s*\d+)\s*(.*)$/i.exec(rest);
      if (!m) return { error: "gen needs a kind and size", hint: "gen dungeon 20x14 rooms=4 seed=7 (kinds: dungeon cave clearing street)" };
      const { props, flags } = parseProps(m[3]);
      if (flags.length) return { error: `unexpected '${flags[0]}'`, hint: "options are key=value, e.g. rooms=3 doors=true seed=42" };
      return { op: "gen", kind: m[1].toLowerCase(), size: parseSize(m[2]), opts: props };
    }
  }
  return { error: `can't read '${s}'`, hint: hintFor(s) };
}

export function parse(text) {
  return splitCommands(text).map((piece, i) => {
    const base = { index: i + 1, src: piece.src };
    if (piece.drawError) return { ...base, error: piece.drawError };
    const out = parseOne(piece.src, piece.rows);
    return out.error ? { ...base, error: out.error, hint: out.hint } : { ...base, cmd: out };
  });
}
