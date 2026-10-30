// Combat turn order strip, shared by the Desktop map card and the game page. It shows what the
// payload carries: wound words for everyone but the player, whose HP numbers are their own.
import { h } from "./dom.js";
import { SIDE, tokenLabel } from "./mapcanvas.js";

/** Fill `el` with the turn order of view.init, or hide it. Scrolls the active entry into view. */
export function renderInitBar(el, view) {
  if (!document.getElementById("initbar-css")) document.head.append(h("style", { id: "initbar-css" }, INIT_CSS));
  const init = !view || view.empty ? null : view.init;
  el.hidden = !init?.order?.length;
  if (el.hidden) return el.replaceChildren();
  const items = init.order.map((t) => {
    const now = t.id === init.current;
    const state = t.side === "player" && typeof t.hp === "number" ? `${t.hp}/${t.maxHp ?? "?"}` : t.wound ?? "";
    const face = t.glyph ? h("span", { class: "ib-face" }, t.glyph) : h("span", { class: "ib-face letters" }, tokenLabel(t).slice(0, 2));
    return h(
      "span",
      {
        class: `ib${now ? " now" : ""}${t.side === "player" ? " me" : ""}${t.wound === "down" ? " down" : ""}`,
        style: `--side:${SIDE[t.side] ?? SIDE.hostile};--tok:${t.color || "#666"}`,
        title: `${tokenLabel(t)}: initiative ${t.n}${state ? ` · ${state}` : ""}${now ? (t.side === "player" ? " · your turn" : " · their turn") : ""}`,
      },
      h("span", { class: "ib-n" }, String(t.n)),
      face,
      h("span", { class: "ib-name" }, tokenLabel(t)),
      state ? h("span", { class: "ib-state" }, state) : null,
      now ? h("span", { class: "ib-turn" }, t.side === "player" ? "your turn" : "turn") : null,
    );
  });
  el.replaceChildren(h("span", { class: "ib-round" }, `Round ${init.round}`), ...items);
  const now = el.querySelector(".ib.now");
  if (now) el.scrollLeft = Math.max(0, now.offsetLeft - el.clientWidth / 2 + now.offsetWidth / 2);
  return el;
}

/** Styles for the strip (injected once, so both UIs stay identical). */
const INIT_CSS = `
.initbar { display: flex; align-items: center; gap: 5px; padding: 5px 10px; overflow-x: auto; scrollbar-width: thin; border-top: 1px solid var(--line); background: rgba(212,166,74,.04); }
.initbar[hidden] { display: none; }
.ib-round { flex: none; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--gold); margin-right: 3px; }
.ib { flex: none; display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 3px; border-radius: 99px; background: #1f2228; border: 1px solid var(--line); font-size: 12px; color: #cfc7b3; white-space: nowrap; }
.ib-n { min-width: 20px; height: 18px; padding: 0 4px; border-radius: 9px; background: #2a2e36; color: #e8e3d6; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; font-variant-numeric: tabular-nums; }
.ib-face { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--tok); box-shadow: 0 0 0 2px var(--side); font-size: 12px; }
.ib-face.letters { font-size: 9px; font-weight: 800; color: #fff; text-transform: capitalize; }
.ib-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; text-transform: capitalize; }
.ib-state { font-size: 11px; color: var(--muted); }
.ib.me .ib-name { color: #bfdbfe; font-weight: 650; }
.ib.me .ib-state { color: #bfdbfe; }
.ib.down { opacity: .5; }
.ib.down .ib-name { text-decoration: line-through; }
.ib.now { border-color: var(--gold); background: rgba(212,166,74,.16); color: #f5e6c0; box-shadow: 0 0 10px rgba(212,166,74,.35); }
.ib.now .ib-n { background: var(--gold); color: #1a1408; }
.ib-turn { font-size: 10px; font-weight: 800; color: #1a1408; background: var(--gold); border-radius: 99px; padding: 0 6px; text-transform: uppercase; letter-spacing: .05em; }
`;
