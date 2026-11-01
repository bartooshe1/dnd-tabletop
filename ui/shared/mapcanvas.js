// The battle-map canvas shared by the Claude Desktop map card and the Claude Code game page:
// textured terrain with glyphs, tokens (player HP numbers, everyone else wound words), rulers,
// zoom/pan/fit/pinch, hover tooltip with distances, a range line, tokens that slide when they
// move, shimmering water and a glow on whoever's turn it is. It never changes the map; clicks
// are reported through onCell.
import { h, reducedMotion } from "./dom.js";
import { styleOf, LIQUID, cellHash, tileCache } from "./tiles.js";
import { conditionInfo } from "./conditions.js";

export const SIDE = { player: "#3b82f6", ally: "#22c55e", neutral: "#eab308", hostile: "#ef4444" };
export const SIDE_NAME = { player: "you", ally: "ally", neutral: "neutral", hostile: "hostile" };
const WOUND = { unhurt: "#9ca3af", hurt: "#facc15", bloodied: "#fb923c", "badly wounded": "#f87171", "near death": "#dc2626", down: "#6b7280" };
const RL = 26; // left ruler width
const RT = 18; // top ruler height
const VOID = "#0c0d10";
const EMOJI = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
const FT_PER_M = 10 / 3;
const SLIDE_MS = 320;
const FX_MS = 70; // ~14 fps for water shimmer, fire flicker and the turn glow

export const cellName = (r, c) => `${r + 1}x${c + 1}`;
export const typeLabel = (id) => id.replace(/_/g, " ");
export const tokenLabel = (t) => t.name || t.type.replace(/_/g, " ");

/**
 * mountMap({ stage, onCell, sizing, maxHeight }) -> api
 * sizing "content": the stage height follows the map, up to maxHeight (inline chat cards).
 * sizing "fill": the stage keeps the height CSS gives it (game page, fullscreen).
 */
export function mountMap({ stage, onCell = () => {}, sizing = "content", maxHeight = 460, wheel = "modifier" }) {
  const canvas = h("canvas", { tabindex: "0", "aria-label": "Battle map" });
  const tip = h("div", { class: "tip", role: "status" });
  stage.append(canvas, tip);
  const ctx = canvas.getContext("2d");
  const S = { view: null, cell: 24, fit: true, ox: 0, oy: 0, hover: null, sel: null, drag: null, pinch: null, anim: null, sizing, maxHeight, wheel, animated: true, visible: true };
  const pointers = new Map();
  const tile = tileCache();
  let fxTimer = 0;
  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver(([e]) => {
      S.visible = e.isIntersecting;
      if (S.visible) draw();
    }).observe(canvas);
  }
  const fxOn = () => S.animated && S.visible && !document.hidden && !reducedMotion();
  // pictures (a map background, the player's portrait) by URL: loaded once, redraw when ready
  const pics = new Map();
  const pic = (url) => {
    if (!url) return null;
    let i = pics.get(url);
    if (!i) {
      i = new Image();
      i.onload = () => draw();
      i.src = url;
      pics.set(url, i);
    }
    return i.complete && i.naturalWidth ? i : null;
  };
  document.addEventListener("visibilitychange", () => !document.hidden && draw());

  const tokenAt = (r, c) => S.view?.tokens?.find((t) => t.r === r && t.c === c) ?? null;
  const player = () => S.view?.tokens?.find((t) => t.side === "player") ?? null;
  const dpr = () => window.devicePixelRatio || 1;
  const cssW = () => canvas.width / dpr();
  const cssH = () => canvas.height / dpr();

  function dist(a, b) {
    const sq = Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c));
    const m = sq * S.view.scale;
    const v = S.view.units === "imperial" ? m * FT_PER_M : m;
    return `${Math.round(v * 10) / 10} ${S.view.units === "imperial" ? "ft" : "m"}`;
  }

  function fitCell(w, hMax) {
    const v = S.view;
    return Math.max(4, Math.min((w - RL - 2) / v.cols, (hMax - RT - 2) / v.rows, 72));
  }

  function layout() {
    const v = S.view;
    if (!v || v.empty) return;
    const w = Math.max(160, stage.clientWidth);
    const hMax = S.sizing === "fill" ? Math.max(120, stage.clientHeight) : S.maxHeight;
    const fc = fitCell(w, hMax);
    const hgt = S.sizing === "fill" ? hMax : Math.ceil(Math.min(hMax, v.rows * fc + RT + 2));
    if (S.sizing !== "fill") stage.style.height = `${hgt}px`;
    canvas.width = Math.round(w * dpr());
    canvas.height = Math.round(hgt * dpr());
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    if (S.fit) {
      S.cell = fc;
      S.ox = Math.max(0, (w - RL - v.cols * fc) / 2);
      S.oy = Math.max(0, (hgt - RT - v.rows * fc) / 2);
    }
    clampPan();
    draw();
  }

  function clampPan() {
    const v = S.view;
    const w = cssW();
    const hgt = cssH();
    const gw = v.cols * S.cell;
    const gh = v.rows * S.cell;
    if (gw + RL <= w) S.ox = Math.max(0, Math.min(S.ox, w - RL - gw));
    else S.ox = Math.min(8, Math.max(Math.min(0, w - RL - gw - 8), S.ox));
    if (gh + RT <= hgt) S.oy = Math.max(0, Math.min(S.oy, hgt - RT - gh));
    else S.oy = Math.min(8, Math.max(Math.min(0, hgt - RT - gh - 8), S.oy));
  }

  function zoomAt(factor, px, py) {
    if (!S.view || S.view.empty) return;
    const next = Math.max(4, Math.min(96, S.cell * factor));
    const gx = (px - RL - S.ox) / S.cell;
    const gy = (py - RT - S.oy) / S.cell;
    S.cell = next;
    S.ox = px - RL - gx * next;
    S.oy = py - RT - gy * next;
    S.fit = false;
    clampPan();
    draw();
  }

  const zoomBy = (f) => zoomAt(f, RL + (cssW() - RL) / 2, RT + (cssH() - RT) / 2);
  const fitNow = () => {
    S.fit = true;
    layout();
  };

  function cellAt(px, py) {
    const v = S.view;
    if (!v || v.empty || px < RL || py < RT) return null;
    const c = Math.floor((px - RL - S.ox) / S.cell);
    const r = Math.floor((py - RT - S.oy) / S.cell);
    return r >= 0 && c >= 0 && r < v.rows && c < v.cols ? { r, c } : null;
  }

  // ---------- drawing ----------
  let frame = 0;
  function draw() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  }

  function paint() {
    const v = S.view;
    if (!v || v.empty) return;
    const w = cssW();
    const hgt = cssH();
    ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    ctx.fillStyle = VOID;
    ctx.fillRect(0, 0, w, hgt);
    const cs = S.cell;
    const x0 = RL + S.ox;
    const y0 = RT + S.oy;
    const c0 = Math.max(0, Math.floor(-S.ox / cs));
    const r0 = Math.max(0, Math.floor(-S.oy / cs));
    const c1 = Math.min(v.cols - 1, Math.ceil((w - RL - S.ox) / cs));
    const r1 = Math.min(v.rows - 1, Math.ceil((hgt - RT - S.oy) / cs));
    ctx.save();
    ctx.beginPath();
    ctx.rect(RL, RT, w - RL, hgt - RT);
    ctx.clip();
    const gap = cs >= 10 ? 1 : 0;
    const textured = cs >= 10;
    const t = fxOn() ? performance.now() / 1000 : 0;
    const P = Math.max(1, Math.round((cs - gap) * dpr()));
    const styles = v.palette.map((p) => styleOf(p.id));
    const solid = v.palette.map((p, i) => styles[i] === "brick" || (p.blocking && !p.glyph));
    let fx = false;
    const bg = pic(v.bgUrl);
    if (bg) {
      // the player's own map picture, stretched over the grid; terrain only shows as a faint tint
      // on blocking squares (the tooltip still names every square) and the grid stays on top
      ctx.drawImage(bg, x0, y0, v.cols * cs, v.rows * cs);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const idx = v.terrain[r][c];
          if (idx < 0 || !v.palette[idx].blocking || v.palette[idx].glyph) continue;
          ctx.fillStyle = "rgba(0,0,0,0.22)";
          ctx.fillRect(x0 + c * cs, y0 + r * cs, cs, cs);
        }
      }
      if (cs >= 8) {
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let c = c0; c <= c1 + 1; c++) {
          ctx.moveTo(Math.round(x0 + c * cs) + 0.5, y0 + r0 * cs);
          ctx.lineTo(Math.round(x0 + c * cs) + 0.5, y0 + (r1 + 1) * cs);
        }
        for (let r = r0; r <= r1 + 1; r++) {
          ctx.moveTo(x0 + c0 * cs, Math.round(y0 + r * cs) + 0.5);
          ctx.lineTo(x0 + (c1 + 1) * cs, Math.round(y0 + r * cs) + 0.5);
        }
        ctx.stroke();
      }
    }
    // 1: terrain tiles
    for (let r = r0; r <= r1 && !bg; r++) {
      for (let c = c0; c <= c1; c++) {
        const idx = v.terrain[r][c];
        if (idx < 0) continue;
        const p = v.palette[idx];
        const x = x0 + c * cs;
        const y = y0 + r * cs;
        if (textured) ctx.drawImage(tile(styles[idx], p.color, cellHash(r, c) % 4, P), x, y, cs - gap, cs - gap);
        else {
          ctx.fillStyle = p.color;
          ctx.fillRect(x, y, cs - gap, cs - gap);
        }
      }
    }
    // 2: shadows cast by walls onto the cells below and right of them, and moving water
    if (textured && !bg) {
      const at = (r, c) => (r >= 0 && c >= 0 && r < v.rows && c < v.cols ? v.terrain[r][c] : -1);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const idx = v.terrain[r][c];
          if (idx < 0 || solid[idx]) continue;
          const x = x0 + c * cs;
          const y = y0 + r * cs;
          const up = at(r - 1, c);
          const left = at(r, c - 1);
          if (up >= 0 && solid[up]) {
            const g = ctx.createLinearGradient(0, y, 0, y + cs * 0.3);
            g.addColorStop(0, "rgba(0,0,0,0.38)");
            g.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = g;
            ctx.fillRect(x, y, cs - gap, cs * 0.3);
          }
          if (left >= 0 && solid[left]) {
            const g = ctx.createLinearGradient(x, 0, x + cs * 0.2, 0);
            g.addColorStop(0, "rgba(0,0,0,0.26)");
            g.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = g;
            ctx.fillRect(x, y, cs * 0.2, cs - gap);
          }
          if (LIQUID.has(styles[idx])) {
            fx = true;
            liquid(styles[idx], x, y, cs - gap, t, cellHash(r, c));
          }
        }
      }
    }
    // 3: glyphs (fire glows and flickers)
    if (cs >= 13) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `${Math.floor(cs * 0.62)}px ${EMOJI}`;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const idx = v.terrain[r][c];
          if (idx < 0) continue;
          const p = v.palette[idx];
          if (!p.glyph) continue;
          const x = x0 + c * cs;
          const y = y0 + r * cs;
          if (p.id === "fire") {
            fx = true;
            const k = cellHash(r, c);
            const al = 0.22 + 0.1 * Math.sin(t * 9 + k) + 0.05 * Math.sin(t * 23 + k * 2);
            const g = ctx.createRadialGradient(x + cs / 2, y + cs / 2, 0, x + cs / 2, y + cs / 2, cs * 0.9);
            g.addColorStop(0, `rgba(255,150,50,${al})`);
            g.addColorStop(1, "rgba(255,150,50,0)");
            ctx.fillStyle = g;
            ctx.fillRect(x - cs * 0.4, y - cs * 0.4, cs * 1.8, cs * 1.8);
          }
          ctx.fillStyle = "#e8e3d6";
          ctx.fillText(p.glyph, x + cs / 2, y + cs / 2 + cs * 0.04);
        }
      }
    }
    const ring = (cell, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.strokeRect(x0 + cell.c * cs + width / 2, y0 + cell.r * cs + width / 2, cs - gap - width, cs - gap - width);
    };
    if (S.hover) ring(S.hover, "rgba(255,255,255,0.55)", Math.max(1, cs * 0.06));
    if (S.sel) ring(S.sel, "#d4a64a", Math.max(2, cs * 0.09));
    const me = player();
    if (me && S.hover && (S.hover.r !== me.r || S.hover.c !== me.c)) {
      ctx.save();
      ctx.setLineDash([Math.max(3, cs * 0.2), Math.max(3, cs * 0.15)]);
      ctx.strokeStyle = "rgba(212,166,74,0.8)";
      ctx.lineWidth = Math.max(1.5, cs * 0.05);
      ctx.beginPath();
      ctx.moveTo(x0 + me.c * cs + cs / 2, y0 + me.r * cs + cs / 2);
      ctx.lineTo(x0 + S.hover.c * cs + cs / 2, y0 + S.hover.r * cs + cs / 2);
      ctx.stroke();
      ctx.restore();
    }
    // tokens, sliding from their previous cell while an animation runs
    const a = S.anim;
    const k = a ? Math.min(1, (performance.now() - a.start) / SLIDE_MS) : 1;
    const ease = 1 - (1 - k) ** 3;
    const current = v.init?.current;
    for (const tk of v.tokens) {
      const from = a?.from.get(tk.id);
      const r = from ? from.r + (tk.r - from.r) * ease : tk.r;
      const c = from ? from.c + (tk.c - from.c) * ease : tk.c;
      if (r < r0 - 1 || r > r1 + 1 || c < c0 - 1 || c > c1 + 1) continue;
      if (tk.id === current) {
        fx = true;
        turnGlow(x0 + c * cs + cs / 2, y0 + r * cs + cs / 2, cs, t);
      }
      drawToken(tk, x0 + c * cs + cs / 2, y0 + r * cs + cs / 2, cs);
    }
    ctx.restore();
    drawRulers(w, hgt, c0, c1, r0, r1);
    if (a && k < 1) draw();
    else S.anim = null;
    if (fx && fxOn() && !fxTimer) {
      fxTimer = setTimeout(() => {
        fxTimer = 0;
        draw();
      }, FX_MS);
    }
  }

  /** Light glints drifting over water; a slow glow pulsing over lava. */
  function liquid(style, x, y, size, t, k) {
    if (style === "lava") {
      ctx.fillStyle = `rgba(255,190,70,${0.07 + 0.07 * Math.sin(t * 1.8 + k)})`;
      ctx.fillRect(x, y, size, size);
      return;
    }
    const al = (style === "deep" ? 0.07 : 0.11) * (0.5 + 0.5 * Math.sin(t * 1.6 + k));
    if (al < 0.01) return;
    const dx = Math.sin(t * 0.7 + k) * size * 0.12;
    ctx.strokeStyle = `rgba(220,240,255,${al})`;
    ctx.lineWidth = Math.max(1, size * 0.035);
    ctx.lineCap = "round";
    ctx.beginPath();
    const gx = x + size * (0.2 + (k % 7) * 0.06) + dx;
    const gy = y + size * (0.3 + (k % 5) * 0.1);
    ctx.moveTo(gx, gy);
    ctx.quadraticCurveTo(gx + size * 0.12, gy - size * 0.06, gx + size * 0.24, gy);
    ctx.stroke();
  }

  /** A pulsing gold ring under the token whose turn it is. */
  function turnGlow(cx, cy, cs, t) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.2);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, cs * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(250,204,21,${0.6 + 0.35 * pulse})`;
    ctx.lineWidth = Math.max(2, cs * 0.07);
    ctx.shadowColor = "rgba(250,204,21,0.95)";
    ctx.shadowBlur = cs * (0.15 + 0.25 * pulse);
    ctx.stroke();
    ctx.restore();
  }

  function drawToken(t, cx, cy, cs) {
    const rad = cs * 0.42;
    const down = t.wound === "down";
    ctx.save();
    if (down) ctx.globalAlpha = 0.55;
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = cs * 0.12;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fillStyle = t.color || "#666";
    ctx.fill();
    ctx.shadowBlur = 0;
    const face = pic(t.portraitUrl);
    if (face) {
      // the player's portrait, cropped to a circle from the middle of the picture
      const side = Math.min(face.naturalWidth, face.naturalHeight);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(face, (face.naturalWidth - side) / 2, (face.naturalHeight - side) / 2, side, side, cx - rad, cy - rad, rad * 2, rad * 2);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    }
    ctx.lineWidth = Math.max(1.5, cs * 0.075);
    ctx.strokeStyle = SIDE[t.side] ?? SIDE.hostile;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (face) {
      /* the picture is the face */
    } else if (t.glyph) {
      ctx.font = `${Math.floor(cs * 0.5)}px ${EMOJI}`;
      ctx.fillText(t.glyph, cx, cy + cs * 0.03);
    } else {
      const s = (t.name || t.type).replace(/_/g, " ");
      const letters = s.slice(0, 1).toUpperCase() + (s[1] ?? "").toLowerCase();
      ctx.font = `700 ${Math.max(7, Math.floor(cs * 0.34))}px system-ui, sans-serif`;
      ctx.fillStyle = "#fff";
      ctx.fillText(letters, cx, cy + 1);
    }
    if (down && cs >= 14) {
      ctx.strokeStyle = "#111";
      ctx.lineWidth = Math.max(2, cs * 0.08);
      ctx.beginPath();
      ctx.moveTo(cx - rad * 0.6, cy - rad * 0.6);
      ctx.lineTo(cx + rad * 0.6, cy + rad * 0.6);
      ctx.moveTo(cx + rad * 0.6, cy - rad * 0.6);
      ctx.lineTo(cx - rad * 0.6, cy + rad * 0.6);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (t.status?.length && cs >= 16) {
      const bx = cx + rad * 0.78;
      const by = cy - rad * 0.78;
      ctx.beginPath();
      ctx.arc(bx, by, Math.max(4, cs * 0.14), 0, Math.PI * 2);
      ctx.fillStyle = "#a855f7";
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${Math.max(7, Math.floor(cs * 0.17))}px system-ui, sans-serif`;
      ctx.fillText(t.status.length > 1 ? String(t.status.length) : t.status[0][0].toUpperCase(), bx, by + 0.5);
    }
    if (cs >= 26) {
      const hp = t.side === "player" && typeof t.hp === "number" ? `${t.hp}/${t.maxHp ?? "?"}` : null;
      const state = hp ?? t.wound ?? null;
      const text = cs >= 44 ? [tokenLabel(t), state].filter(Boolean).join(" · ") : state;
      if (text) {
        ctx.font = `600 ${cs >= 44 ? 11 : 10}px system-ui, sans-serif`;
        const tw = ctx.measureText(text).width + 8;
        const py = cy + rad + 1;
        ctx.fillStyle = "rgba(10,11,14,0.85)";
        roundRect(cx - tw / 2, py - 7, tw, 14, 7);
        ctx.fill();
        ctx.fillStyle = hp ? (t.hp <= (t.maxHp ?? 1) / 4 ? "#f87171" : "#bfdbfe") : WOUND[t.wound] ?? "#e8e3d6";
        ctx.fillText(text, cx, py + 0.5);
      }
    }
    ctx.restore();
  }

  function roundRect(x, y, w, hgt, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + hgt, r);
    ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
    ctx.arcTo(x, y + hgt, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawRulers(w, hgt, c0, c1, r0, r1) {
    const cs = S.cell;
    ctx.fillStyle = "#15171c";
    ctx.fillRect(0, 0, w, RT);
    ctx.fillRect(0, 0, RL, hgt);
    ctx.font = "600 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const step = cs >= 18 ? 1 : cs >= 9 ? 5 : 10;
    for (let c = c0; c <= c1; c++) {
      const n = c + 1;
      if (step > 1 && n !== 1 && n % step) continue;
      const x = RL + S.ox + c * cs + cs / 2;
      if (x < RL) continue;
      ctx.fillStyle = S.hover?.c === c ? "#d4a64a" : "#8f8a7d";
      ctx.fillText(String(n), x, RT / 2 + 1);
    }
    ctx.textAlign = "right";
    for (let r = r0; r <= r1; r++) {
      const n = r + 1;
      if (step > 1 && n !== 1 && n % step) continue;
      const y = RT + S.oy + r * cs + cs / 2;
      if (y < RT) continue;
      ctx.fillStyle = S.hover?.r === r ? "#d4a64a" : "#8f8a7d";
      ctx.fillText(String(n), RL - 5, y);
    }
    ctx.fillStyle = "#15171c";
    ctx.fillRect(0, 0, RL, RT);
    ctx.fillStyle = "#5d594f";
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("R×C", RL / 2, RT / 2 + 1);
  }

  // ---------- tooltip ----------
  function showTip(cell, px, py) {
    const v = S.view;
    const idx = v.terrain[cell.r][cell.c];
    const lines = [];
    const ter = idx >= 0 ? typeLabel(v.palette[idx].id) + (v.palette[idx].blocking ? " (blocks)" : "") : "nothing";
    lines.push(h("div", { class: "tip-head" }, h("b", {}, cellName(cell.r, cell.c)), ` · ${ter}`));
    const t = tokenAt(cell.r, cell.c);
    if (t) {
      const bits = [`${tokenLabel(t)}${t.name ? ` (${t.id})` : ` · ${t.id}`}`, SIDE_NAME[t.side]];
      if (t.side === "player" && typeof t.hp === "number") bits.push(`${t.hp}/${t.maxHp ?? "?"} HP`);
      else if (t.wound) bits.push(t.wound);
      lines.push(h("div", {}, h("span", { class: "dot", style: `background:${SIDE[t.side]}` }), bits.join(" · ")));
      for (const st of t.status ?? []) {
        const info = conditionInfo(st);
        lines.push(h("div", { class: "muted" }, h("b", {}, st), info ? `: ${info.lines[0]}` : ""));
      }
    }
    const me = player();
    if (me && (me.r !== cell.r || me.c !== cell.c)) lines.push(h("div", { class: "muted" }, `${dist(me, cell)} from ${me.name || "you"}`));
    tip.replaceChildren(...lines);
    tip.style.display = "block";
    const w = stage.clientWidth;
    let x = px + 14;
    let y = py + 14;
    if (x + tip.offsetWidth > w - 4) x = px - tip.offsetWidth - 10;
    if (y + tip.offsetHeight > stage.clientHeight - 4) y = py - tip.offsetHeight - 10;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  }
  const hideTip = () => (tip.style.display = "none");

  // ---------- input ----------
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      S.pinch = { d: Math.hypot(p.x - q.x, p.y - q.y) };
      S.drag = null;
    } else S.drag = { ...local(e), ox: S.ox, oy: S.oy, moved: false };
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (S.pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(d / S.pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      S.pinch.d = d;
      return;
    }
    if (S.drag) {
      const dx = p.x - S.drag.x;
      const dy = p.y - S.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) S.drag.moved = true;
      if (S.drag.moved) {
        S.ox = S.drag.ox + dx;
        S.oy = S.drag.oy + dy;
        S.fit = false;
        clampPan();
        hideTip();
        draw();
        return;
      }
    }
    const cell = cellAt(p.x, p.y);
    const changed = cell?.r !== S.hover?.r || cell?.c !== S.hover?.c;
    S.hover = cell;
    if (cell && e.pointerType !== "touch") showTip(cell, p.x, p.y);
    else hideTip();
    if (changed) draw();
  });
  const endPointer = (e) => {
    const wasDrag = S.drag?.moved;
    const p = local(e);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) S.pinch = null;
    if (S.drag && !wasDrag && e.type === "pointerup") {
      const cell = cellAt(p.x, p.y);
      if (cell) {
        S.sel = cell;
        if (e.pointerType === "touch") showTip(cell, p.x, p.y);
        draw();
        onCell(cell, tokenAt(cell.r, cell.c));
      }
    }
    S.drag = null;
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => {
    if (!S.drag) {
      S.hover = null;
      hideTip();
      draw();
    }
  });
  // In a chat, a plain wheel scrolls the conversation; ctrl/cmd + wheel (and trackpad pinch) zooms.
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (S.wheel === "modifier" && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const p = local(e);
      zoomAt(Math.exp(-e.deltaY * 0.0025), p.x, p.y);
    },
    { passive: false },
  );
  canvas.addEventListener("keydown", (e) => {
    if (e.key === "+" || e.key === "=") zoomBy(1.25);
    else if (e.key === "-") zoomBy(1 / 1.25);
    else if (e.key === "0") fitNow();
  });
  new ResizeObserver(() => S.view && !S.view.empty && layout()).observe(stage);

  return {
    /** Show a payload. Same map + moved tokens = slide them; another map = refit. */
    render(view) {
      const prev = S.view;
      const sameMap = prev && !prev.empty && view && !view.empty && prev.name === view.name && prev.cols === view.cols && prev.rows === view.rows;
      S.view = view;
      if (!view || view.empty) return;
      if (sameMap) {
        const from = new Map();
        for (const t of prev.tokens) {
          const now = view.tokens.find((x) => x.id === t.id);
          if (now && (now.r !== t.r || now.c !== t.c)) from.set(t.id, { r: t.r, c: t.c });
        }
        if (from.size && !matchMedia("(prefers-reduced-motion: reduce)").matches) S.anim = { from, start: performance.now() };
        draw();
      } else {
        S.fit = true;
        S.sel = null;
        layout();
      }
    },
    layout,
    fit: fitNow,
    zoomBy,
    clearSelection() {
      S.sel = null;
      draw();
    },
    setSizing(sizing) {
      S.sizing = sizing;
      if (sizing === "fill") stage.style.height = "";
      S.fit = true;
      layout();
    },
    setWheel(mode) {
      S.wheel = mode;
    },
    /** Older map cards stop shimmering; only the newest one moves. */
    setAnimated(on) {
      S.animated = !!on;
      draw();
    },
    get view() {
      return S.view;
    },
  };
}

/** Legend items for the terrain types and token sides present on a map. */
export function legendItems(v) {
  const used = new Set(v.terrain.flat());
  const items = v.palette
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => used.has(i))
    .map(({ p }) =>
      h("span", { class: "lg", title: p.blocking ? "blocks movement" : "" }, h("span", { class: "sw", style: `background:${p.color}` }, p.glyph || ""), typeLabel(p.id) + (p.blocking ? "*" : "")),
    );
  const sides = [...new Set(v.tokens.map((t) => t.side))].map((s) => h("span", { class: "lg" }, h("span", { class: "dot", style: `background:${SIDE[s]}` }), SIDE_NAME[s]));
  return [...items, sides.length ? h("span", { class: "sep" }) : null, ...sides, h("span", { class: "lg muted", title: "Distances count diagonals as one square (5e)" }, "* blocks movement")].filter(Boolean);
}

export function scaleText(v) {
  const m = v.scale;
  return v.units === "imperial" ? `${Math.round(m * FT_PER_M * 10) / 10} ft` : `${Math.round(m * 100) / 100} m`;
}
