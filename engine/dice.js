// Dice: notation parsing, validation and rolling with crypto.randomInt. Claude never supplies numbers.
import { randomInt } from "node:crypto";

export const SIDES = [4, 6, 8, 10, 12, 20, 100];
const MAX_DICE_PER_TERM = 20;
const MAX_ROLLS = 20;
const MAX_MOD = 100;

const TERM = String.raw`(?:\d*\s*d\s*\d+|\d+)`;
const EXPR = new RegExp(String.raw`^\s*([+-]?\s*${TERM}(?:\s*[+-]\s*${TERM})*)`, "i");

export class DiceError extends Error {}

/** Parse one expression like "1d20+5" or "2d6 + 1d4 - 1" into terms. */
export function parseExpr(text) {
  const src = text.replace(/\s+/g, "").toLowerCase();
  const terms = [];
  const re = /([+-]?)(\d*)d(\d+)|([+-]?)(\d+)/g;
  let m;
  let consumed = 0;
  while ((m = re.exec(src))) {
    if (m.index !== consumed) break;
    consumed = re.lastIndex;
    if (m[3] !== undefined) {
      const count = m[2] === "" ? 1 : Number(m[2]);
      const sides = Number(m[3]);
      if (!SIDES.includes(sides)) throw new DiceError(`d${sides} isn't a die here (use d4 d6 d8 d10 d12 d20 d100)`);
      if (count < 1 || count > MAX_DICE_PER_TERM) throw new DiceError(`${count}d${sides}: 1 to ${MAX_DICE_PER_TERM} dice per group`);
      terms.push({ sign: m[1] === "-" ? -1 : 1, count, sides });
    } else {
      terms.push({ sign: m[4] === "-" ? -1 : 1, value: Number(m[5]) });
    }
  }
  if (consumed !== src.length || !terms.length) throw new DiceError(`can't read '${text.trim()}'`);
  if (!terms.some((t) => t.sides)) throw new DiceError(`'${text.trim()}' has no dice`);
  const mod = terms.filter((t) => t.value !== undefined).reduce((s, t) => s + t.sign * t.value, 0);
  if (Math.abs(mod) > MAX_MOD) throw new DiceError(`modifier ${mod} is out of range (±${MAX_MOD})`);
  return terms;
}

/**
 * Parse a full dice spec: "1d20+5 atk, 1d8+3 dmg, 4*(1d20+2) init".
 * Returns [{ expr, label }] with repeats expanded (labels numbered).
 */
export function parseSpec(spec) {
  const items = String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.length) throw new DiceError("no dice given (e.g. 1d20+5)");
  const out = [];
  for (const item of items) {
    const rep = /^(\d+)\s*[*x×]\s*\((.+?)\)\s*(.*)$/i.exec(item);
    if (rep) {
      const n = Number(rep[1]);
      if (n < 1 || n > MAX_ROLLS) throw new DiceError(`repeat ${n}: use 1 to ${MAX_ROLLS}`);
      parseExpr(rep[2]);
      for (let i = 1; i <= n; i++) out.push({ expr: rep[2].replace(/\s+/g, ""), label: rep[3] ? `${rep[3]} ${i}` : `#${i}` });
      continue;
    }
    const m = EXPR.exec(item);
    if (!m) throw new DiceError(`can't read '${item}' (e.g. 1d20+5 atk)`);
    parseExpr(m[1]);
    out.push({ expr: m[1].replace(/\s+/g, ""), label: item.slice(m[0].length).trim() });
  }
  if (out.length > MAX_ROLLS) throw new DiceError(`${out.length} rolls in one call; max ${MAX_ROLLS}`);
  return out;
}

const d = (sides) => randomInt(1, sides + 1);

/** Roll one parsed item. mode "adv"/"dis" applies to a single 1d20 group. */
export function rollOne({ expr, label }, mode, roll = d) {
  const terms = parseExpr(expr);
  const d20 = terms.filter((t) => t.sides === 20 && t.count === 1);
  const useMode = mode && d20.length === 1 ? mode : null;
  let total = 0;
  let nat = null;
  const groups = terms.map((t) => {
    if (t.value !== undefined) {
      total += t.sign * t.value;
      return { sign: t.sign, value: t.value };
    }
    const rolls = Array.from({ length: t.count }, () => roll(t.sides));
    const g = { sign: t.sign, sides: t.sides, rolls };
    if (useMode && t.sides === 20 && t.count === 1) {
      const other = roll(20);
      const pair = [rolls[0], other];
      const keep = useMode === "adv" ? Math.max(...pair) : Math.min(...pair);
      g.rolls = [keep];
      g.pair = pair;
      g.mode = useMode;
    }
    const sum = g.rolls.reduce((a, b) => a + b, 0);
    total += t.sign * sum;
    if (t.sides === 20 && t.count === 1 && t.sign > 0 && nat === null) nat = g.rolls[0];
    return g;
  });
  return { label, expr, groups, total, nat: nat === 20 || nat === 1 ? nat : null, mode: useMode };
}

export function rollSpec(spec, mode, roll = d) {
  const items = parseSpec(spec);
  if (mode && !items.some((i) => parseExpr(i.expr).some((t) => t.sides === 20 && t.count === 1))) {
    throw new DiceError(`${mode === "adv" ? "advantage" : "disadvantage"} needs a 1d20 roll`);
  }
  return items.map((i) => rollOne(i, mode, roll));
}

/** "atk 1d20+5 (adv): [14|7]+5 = 19 NAT 20" */
export function rollText(r) {
  const parts = r.groups.map((g, i) => {
    const sign = g.sign < 0 ? "-" : i === 0 ? "" : "+";
    if (g.value !== undefined) return `${sign}${g.value}`;
    if (g.pair) return `${sign}[${g.pair.join("|")}]`;
    return `${sign}[${g.rolls.join(",")}]`;
  });
  const nat = r.nat === 20 ? " NAT 20" : r.nat === 1 ? " NAT 1" : "";
  return `${r.label ? `${r.label} ` : ""}${r.expr}${r.mode ? ` (${r.mode})` : ""}: ${parts.join("")} = ${r.total}${nat}`;
}
