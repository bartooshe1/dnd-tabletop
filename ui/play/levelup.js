// XP progress read from the character sheet text, and the level-up guide. The guide never
// changes anything itself: it rolls the hit die through the dice tray and sends the player's
// choices to the DM, who updates the sheet.
import { h } from "../shared/dom.js";

/** XP needed to reach level i+1 (5e Player's Handbook table). */
export const XP_FOR = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

const HIT_DIE = { barbarian: 12, fighter: 10, paladin: 10, ranger: 10, bard: 8, cleric: 8, druid: 8, monk: 8, rogue: 8, warlock: 8, artificer: 8, sorcerer: 6, wizard: 6 };
const CLASSES = Object.keys(HIT_DIE);
const ASI = { fighter: [4, 6, 8, 12, 14, 16, 19], rogue: [4, 8, 10, 12, 16, 19] };
const SUBCLASS_AT = { cleric: 1, sorcerer: 1, warlock: 1, druid: 2, wizard: 2 };
const CASTER_FROM = { bard: 1, cleric: 1, druid: 1, sorcerer: 1, warlock: 1, wizard: 1, artificer: 1, paladin: 2, ranger: 2 };
const ABILITIES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];

const num = (s) => Number(String(s).replace(/[^\d]/g, ""));
const prof = (level) => 2 + Math.floor((level - 1) / 4);

/** { xp, level, cls, hitDie, con, next, canLevel } from the Character section, or null. */
export function parseProgress(body) {
  const text = String(body ?? "").replace(/[*_`]/g, "");
  const xpM = /\bXP\b\D{0,4}(\d[\d,]*)/i.exec(text);
  const clsM = new RegExp(`\\b(${CLASSES.join("|")})\\b(?:\\s*\\(?[A-Za-z ]*\\)?)?\\s*(\\d{1,2})?`, "i").exec(text);
  const lvM = /\b(?:Level|Lvl|Lv)\.?\s*(\d{1,2})\b/i.exec(text) ?? (clsM?.[2] ? [null, clsM[2]] : null);
  const xp = xpM ? num(xpM[1]) : null;
  let level = lvM ? Number(lvM[1]) : null;
  if (level === null && xp !== null) level = XP_FOR.filter((t) => xp >= t).length;
  if (!level || level > 20) return xp === null ? null : { xp, level: null, next: null, canLevel: false };
  const cls = clsM ? clsM[1].toLowerCase() : null;
  const dieM = /Hit dice?\D{0,12}d(6|8|10|12)\b/i.exec(text);
  const conM = /\bCON\b\s*\d{0,2}\s*\(?\s*([+\-−]\s*\d)/i.exec(text);
  const next = level < 20 ? XP_FOR[level] : null;
  return {
    xp,
    level,
    cls,
    hitDie: dieM ? Number(dieM[1]) : cls ? HIT_DIE[cls] : null,
    con: conM ? Number(conM[1].replace("−", "-").replace(/\s/g, "")) : null,
    next,
    canLevel: xp !== null && next !== null && xp >= next,
  };
}

/** The XP bar for the sheet header. onLevel opens the guide. */
export function xpBar(p, onLevel) {
  if (!p || p.xp === null) return null;
  const prev = p.level ? XP_FOR[p.level - 1] : 0;
  const pct = p.next ? Math.max(0, Math.min(100, ((p.xp - prev) / (p.next - prev)) * 100)) : 100;
  return h(
    "div",
    { class: "xp" },
    h("div", { class: "xp-top" }, h("span", {}, p.level ? `Level ${p.level}` : ""), h("span", { class: "xp-num" }, p.next ? `XP ${p.xp.toLocaleString()} / ${p.next.toLocaleString()}` : `XP ${p.xp.toLocaleString()}`)),
    h("span", { class: "xp-bar" }, h("span", { class: `xp-fill${p.canLevel ? " full" : ""}`, style: `width:${pct}%` })),
    p.canLevel ? h("button", { class: "btn levelup", type: "button", onclick: onLevel }, `⬆ Level up to ${p.level + 1}!`) : null,
  );
}

/**
 * Open the level-up guide. roll(dice) rolls in the tray; send(text) sends a message.
 * Returns the dialog element (already in the page).
 */
export function openLevelUp(p, { roll, send }) {
  const to = p.level + 1;
  const cls = p.cls;
  const die = p.hitDie ?? 8;
  const con = p.con ?? 0;
  const avg = die / 2 + 1;
  const state = { hp: "average", rolled: false };
  const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const close = () => dlg.remove();
  const field = (placeholder) => h("input", { type: "text", class: "lu-in", maxlength: "200", placeholder });
  const pick = (name) => h("select", { class: "lu-sel", "aria-label": name }, ABILITIES.map((a) => h("option", { value: a }, a)));

  const hpAvg = h("input", { type: "radio", name: "lu-hp", checked: true, onchange: () => (state.hp = "average") });
  const hpRoll = h("input", { type: "radio", name: "lu-hp", onchange: () => (state.hp = "roll") });
  const rollBtn = h(
    "button",
    {
      class: "btn small",
      type: "button",
      onclick: async () => {
        hpRoll.checked = true;
        state.hp = "roll";
        const r = await roll(`1d${die}`);
        if (r) {
          state.rolled = true;
          rollBtn.disabled = true;
          rollBtn.textContent = `Rolled ${r.total}`;
        }
      },
    },
    `Roll 1d${die}`,
  );
  const parts = [
    h("h3", {}, "Hit points"),
    h("label", { class: "lu-row" }, hpAvg, `Take the average: ${avg} ${sign(con)} CON = `, h("b", {}, `+${Math.max(1, avg + con)} HP`)),
    h("label", { class: "lu-row" }, hpRoll, `Roll your hit die (d${die}) ${sign(con)} CON `, rollBtn),
  ];
  if (prof(to) > prof(p.level)) parts.push(h("p", { class: "lu-note" }, `Your proficiency bonus goes up to +${prof(to)}.`));

  let asi = null;
  if ((ASI[cls] ?? [4, 8, 12, 16, 19]).includes(to)) {
    const one = pick("Ability for +2");
    const a1 = pick("First ability for +1");
    const a2 = pick("Second ability for +1");
    const feat = field("Which feat?");
    const mode = { v: "two" };
    const radio = (v, label, ...rest) => h("label", { class: "lu-row" }, h("input", { type: "radio", name: "lu-asi", checked: v === "two", onchange: () => (mode.v = v) }), label, ...rest);
    parts.push(h("h3", {}, "Ability Score Improvement"), radio("two", "+2 to ", one), radio("split", "+1 to ", a1, " and +1 to ", a2), radio("feat", "A feat instead: ", feat));
    asi = () => (mode.v === "two" ? `+2 ${one.value}` : mode.v === "split" ? `+1 ${a1.value}, +1 ${a2.value}` : `the feat ${feat.value.trim() || "(I'd like suggestions)"}`);
  }
  let sub = null;
  if (to === (SUBCLASS_AT[cls] ?? 3)) {
    sub = field("Your subclass (or ask the DM for the options)");
    parts.push(h("h3", {}, "Subclass"), sub);
  }
  let spells = null;
  if (cls && CASTER_FROM[cls] && to >= CASTER_FROM[cls]) {
    spells = field("New spells you'd like (optional)");
    parts.push(h("h3", {}, "Spells"), spells);
  }
  const other = field("Anything else? (optional)");
  parts.push(h("h3", {}, "Other"), other, h("p", { class: "lu-note" }, "Your DM checks the rules and updates your sheet. Class features for the new level come from the DM."));

  const sendBtn = h(
    "button",
    {
      class: "btn send",
      type: "button",
      onclick: async () => {
        const bits = [`Level up to ${to}!`];
        bits.push(state.hp === "roll" ? `HP: I rolled my d${die}${state.rolled ? " (roll attached)" : " (please roll it for me)"} ${sign(con)} CON.` : `HP: I take the average, ${avg} ${sign(con)} CON.`);
        if (asi) bits.push(`ASI: ${asi()}.`);
        if (sub?.value.trim()) bits.push(`Subclass: ${sub.value.trim()}.`);
        if (spells?.value.trim()) bits.push(`New spells: ${spells.value.trim()}.`);
        if (other.value.trim()) bits.push(other.value.trim());
        bits.push("Please update my sheet and tell me what else I gain.");
        if (await send(bits.join(" "))) close();
      },
    },
    "Send to the DM",
  );
  const dlg = h(
    "div",
    { class: "settings levelup-dlg", role: "dialog", "aria-label": "Level up" },
    h(
      "div",
      { class: "settings-card" },
      h("div", { class: "settings-head" }, h("b", {}, `⬆ Level ${p.level} → ${to}${cls ? ` ${cls[0].toUpperCase()}${cls.slice(1)}` : ""}`), h("button", { class: "btn icon", type: "button", "aria-label": "Close", onclick: close }, "✕")),
      ...parts,
      h("div", { class: "lu-actions" }, h("button", { class: "btn", type: "button", onclick: close }, "Later"), sendBtn),
    ),
  );
  dlg.addEventListener("click", (e) => e.target === dlg && close());
  document.body.append(dlg);
  return dlg;
}
