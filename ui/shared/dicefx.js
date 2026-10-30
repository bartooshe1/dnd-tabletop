// Animated SVG dice shared by the Claude Desktop dice card and the Claude Code game page.
// Each die tumbles ~1.3s while its face cycles and slows down, then lands on the server's value.
// Purely visual: the number shown at the end is always the real roll.
import { h, reducedMotion } from "./dom.js";

const SVG = "http://www.w3.org/2000/svg";
export const SHAPES = {
  4: { points: "50,7 95,88 5,88", ty: 66, fill: "#2f855a" },
  6: { rect: true, ty: 52, fill: "#e2dccd", ink: "#1d1b17" },
  8: { points: "50,4 95,50 50,96 5,50", ty: 52, fill: "#2b6cb0" },
  10: { points: "50,4 93,40 50,96 7,40", ty: 50, fill: "#2c7a7b" },
  12: { points: "50,4 96,37 79,93 21,93 4,37", ty: 56, fill: "#6b46c1" },
  20: { points: "50,3 93,27 93,73 50,97 7,73 7,27", ty: 53, fill: "#b7322c", facets: true },
  100: { points: "50,4 93,40 50,96 7,40", ty: 50, fill: "#975a16" },
};
export const DURATION = 1300;

function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

export function dieNode(sides) {
  const s = SHAPES[sides] ?? SHAPES[20];
  const svg = svgEl("svg", { viewBox: "0 0 100 100", "aria-hidden": "true" });
  const shape = s.rect ? svgEl("rect", { x: 9, y: 9, width: 82, height: 82, rx: 14 }) : svgEl("polygon", { points: s.points });
  shape.setAttribute("fill", s.fill);
  shape.setAttribute("class", "face");
  svg.append(shape);
  if (s.facets) for (const p of ["50,3 27,62 73,62", "27,62 50,97 73,62"]) svg.append(svgEl("polyline", { points: p, class: "facet" }));
  const text = svgEl("text", { x: 50, y: s.ty, "text-anchor": "middle", "dominant-baseline": "middle", class: "num", fill: s.ink ?? "#fff" });
  text.textContent = "?";
  svg.append(text);
  const node = h("div", { class: `die d${sides}`, title: sides === 100 ? "d100" : `d${sides}` }, svg, h("span", { class: "dtype" }, sides === 100 ? "d%" : `d${sides}`));
  node.setValue = (v) => {
    text.textContent = String(v);
    text.setAttribute("font-size", v >= 100 ? 26 : v >= 10 ? 34 : 40);
  };
  return node;
}

/** Spin a die: faces cycle and slow down, then land on `final`. `alive()` cancels stale spins. */
export function spin(node, sides, final, delay, alive, done, instant = false) {
  if (instant || reducedMotion()) {
    node.setValue(final);
    node.classList.add("settled");
    done();
    return;
  }
  node.setValue(1 + Math.floor(Math.random() * sides));
  setTimeout(() => {
    if (!alive()) return;
    node.classList.add("rolling");
    let elapsed = 0;
    let step = 42;
    const tick = () => {
      if (!alive()) return;
      elapsed += step;
      if (elapsed < DURATION) {
        node.setValue(1 + Math.floor(Math.random() * sides));
        step *= 1.13;
        setTimeout(tick, step);
      } else {
        node.setValue(final);
        node.classList.remove("rolling");
        node.classList.add("settled");
        done();
      }
    };
    tick();
  }, delay);
}

/**
 * Build animated rows for server rolls ([{ label, expr, groups, total, nat }]).
 * Returns { el, done: Promise } where done resolves when every die has landed.
 */
export function rollRows(rolls, { alive = () => true, compact = false, instant = false } = {}) {
  let k = 0;
  const waits = [];
  const rows = rolls.map((r) => {
    const diceBox = h("div", { class: "dice" });
    const totalEl = h("div", { class: "total pending" }, "…");
    const row = h("div", { class: `row${compact ? " compact" : ""}` }, h("div", { class: "rlabel" }, r.label || r.expr), diceBox, totalEl);
    let pending = 0;
    let resolveRow;
    waits.push(new Promise((res) => (resolveRow = res)));
    const settleOne = () => {
      if (--pending > 0) return;
      totalEl.textContent = String(r.total);
      totalEl.classList.remove("pending");
      totalEl.classList.add("shown");
      if (r.nat === 20) row.classList.add("nat20");
      if (r.nat === 1) row.classList.add("nat1");
      for (const d of diceBox.querySelectorAll(".will-drop")) d.classList.add("dropped");
      resolveRow();
    };
    r.groups.forEach((g, gi) => {
      if (g.value !== undefined) {
        diceBox.append(h("span", { class: "mod" }, `${g.sign < 0 ? "−" : "+"}${g.value}`));
        return;
      }
      if (g.sign < 0 || gi > 0) diceBox.append(h("span", { class: "op" }, g.sign < 0 ? "−" : "+"));
      const faces = g.pair ?? g.rolls;
      const keptAt = g.pair ? g.pair.indexOf(g.rolls[0]) : -1;
      faces.forEach((value, i) => {
        const node = dieNode(g.sides);
        if (g.pair && i !== keptAt) node.classList.add("will-drop");
        if (g.sides === 20 && (value === 20 || value === 1) && (!g.pair || i === keptAt)) node.classList.add(value === 20 ? "is20" : "is1");
        diceBox.append(node);
        pending++;
        spin(node, g.sides, value, Math.min(1000, k++ * 90), alive, settleOne, instant);
      });
    });
    if (!pending) settleOne();
    return row;
  });
  return { el: h("div", { class: "rows" }, rows), done: Promise.all(waits) };
}
