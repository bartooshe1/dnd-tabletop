// Terrain art for the battle map, drawn in code (no image files): flagstones, brick walls,
// wooden planks, water, lava, grass, cobbles, rugs... Each tile is painted once per
// style, color, variant and pixel size, then reused for every cell.

const STYLE_OF = {
  floor: "stone", chest: "stone", trap: "stone", chair: "stone", bed: "stone", fire: "stone", pillar: "stone",
  barrel: "stone", crate: "stone", statue: "stone", well: "stone", altar: "stone",
  wall: "brick",
  door: "wood", door_locked: "wood", table: "wood", bar: "wood", fence: "wood", market_stall: "wood", bookshelf: "wood",
  water: "water", deep_water: "deep", lava: "lava",
  grass: "grass", bush: "grass", tree: "grass",
  road: "cobble", rubble: "rubble", rug: "rug",
  stairs_up: "stairs", stairs_down: "stairs", ladder: "stairs",
  window: "window",
};

/** Art style for a terrain id; custom types are guessed from their name. */
export function styleOf(id) {
  if (STYLE_OF[id]) return STYLE_OF[id];
  if (/deep|lake|sea|ocean/.test(id)) return "deep";
  if (/water|pool|river|stream|swamp|marsh|puddle/.test(id)) return "water";
  if (/lava|magma/.test(id)) return "lava";
  if (/grass|moss|leaf|forest|field|meadow|hedge/.test(id)) return "grass";
  if (/wood|plank|deck|bridge|board|table|crate/.test(id)) return "wood";
  if (/wall|cliff|brick/.test(id)) return "brick";
  if (/cobble|road|path|street/.test(id)) return "cobble";
  if (/rug|carpet/.test(id)) return "rug";
  if (/stone|tile|marble|floor|slab/.test(id)) return "stone";
  return "plain";
}

/** Styles whose cells shimmer when animation is on. */
export const LIQUID = new Set(["water", "deep", "lava"]);

function rgb(hex) {
  let x = /^#([0-9a-f]{3,8})$/i.exec(hex)?.[1] ?? "555";
  if (x.length < 6) x = [...x.slice(0, 3)].map((c) => c + c).join("");
  const n = parseInt(x.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Lighten (f > 0) or darken (f < 0) a hex color. */
export function shade(hex, f, a = 1) {
  const m = (v) => Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f));
  const [r, g, b] = rgb(hex);
  return `rgba(${m(r)},${m(g)},${m(b)},${a})`;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let x = 2166136261;
  for (const ch of s) x = Math.imul(x ^ ch.charCodeAt(0), 16777619);
  return x >>> 0;
}

/** Stable per-cell number, for picking variants and animation phases. */
export const cellHash = (r, c) => ((Math.imul(r + 1, 73856093) ^ Math.imul(c + 1, 19349663)) >>> 0) % 1000;

function speckle(g, P, rnd, count, alpha) {
  for (let i = 0; i < count; i++) {
    g.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha * 1.4})`;
    const s = Math.max(1, P * (0.015 + rnd() * 0.025));
    g.fillRect(rnd() * P, rnd() * P, s, s);
  }
}

const PAINT = {
  stone(g, col, P, rnd, v) {
    g.fillStyle = shade(col, -0.3);
    g.fillRect(0, 0, P, P);
    const slabs = [
      [[0, 0, 1, 1]],
      [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]],
      [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]],
      [[0, 0, 0.58, 0.5], [0.58, 0, 0.42, 0.5], [0, 0.5, 0.38, 0.5], [0.38, 0.5, 0.62, 0.5]],
    ][v % 4];
    const j = Math.max(1, P * 0.03);
    for (const [x, y, w, hh] of slabs) {
      const X = x * P + j / 2;
      const Y = y * P + j / 2;
      const W = w * P - j;
      const H = hh * P - j;
      g.fillStyle = shade(col, (rnd() - 0.5) * 0.16);
      g.fillRect(X, Y, W, H);
      g.fillStyle = "rgba(255,255,255,0.06)";
      g.fillRect(X, Y, W, j);
      g.fillRect(X, Y, j, H);
      g.fillStyle = "rgba(0,0,0,0.14)";
      g.fillRect(X, Y + H - j, W, j);
      g.fillRect(X + W - j, Y, j, H);
    }
    speckle(g, P, rnd, Math.min(40, (P * P) / 120), 0.05);
    if (rnd() < 0.25) {
      // a hairline crack
      g.strokeStyle = "rgba(0,0,0,0.25)";
      g.lineWidth = Math.max(0.6, P * 0.01);
      g.beginPath();
      let x = rnd() * P;
      let y = rnd() * P;
      g.moveTo(x, y);
      for (let i = 0; i < 3; i++) g.lineTo((x += (rnd() - 0.5) * P * 0.3), (y += (rnd() - 0.5) * P * 0.3));
      g.stroke();
    }
  },

  brick(g, col, P, rnd) {
    g.fillStyle = shade(col, -0.45);
    g.fillRect(0, 0, P, P);
    const rows = 3;
    const rh = P / rows;
    const m = Math.max(1, P * 0.035);
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? 0.5 : 0;
      for (let k = -1; k < 2; k++) {
        const x = (k + off) * (P / 2);
        g.fillStyle = shade(col, (rnd() - 0.5) * 0.18 - 0.04);
        g.fillRect(x + m / 2, r * rh + m / 2, P / 2 - m, rh - m);
        g.fillStyle = "rgba(255,255,255,0.08)";
        g.fillRect(x + m / 2, r * rh + m / 2, P / 2 - m, m);
      }
    }
    speckle(g, P, rnd, Math.min(30, (P * P) / 150), 0.06);
    const lg = g.createLinearGradient(0, 0, 0, P);
    lg.addColorStop(0, "rgba(255,255,255,0.14)");
    lg.addColorStop(0.45, "rgba(255,255,255,0)");
    lg.addColorStop(1, "rgba(0,0,0,0.28)");
    g.fillStyle = lg;
    g.fillRect(0, 0, P, P);
  },

  wood(g, col, P, rnd) {
    g.fillStyle = shade(col, -0.4);
    g.fillRect(0, 0, P, P);
    const n = 3;
    const ph = P / n;
    const m = Math.max(1, P * 0.025);
    for (let i = 0; i < n; i++) {
      const y = i * ph + m / 2;
      const hgt = ph - m;
      g.fillStyle = shade(col, (rnd() - 0.5) * 0.14);
      g.fillRect(0, y, P, hgt);
      g.strokeStyle = shade(col, -0.25, 0.6);
      g.lineWidth = Math.max(0.6, P * 0.012);
      for (let k = 0; k < 2; k++) {
        const gy = y + hgt * (0.25 + rnd() * 0.5);
        g.beginPath();
        g.moveTo(0, gy);
        g.bezierCurveTo(P * 0.3, gy + (rnd() - 0.5) * hgt * 0.5, P * 0.7, gy + (rnd() - 0.5) * hgt * 0.5, P, gy);
        g.stroke();
      }
      if (rnd() < 0.4) {
        const x = P * (0.15 + rnd() * 0.7);
        g.fillStyle = "rgba(0,0,0,0.35)";
        g.fillRect(x, y, m, hgt);
      }
      if (rnd() < 0.2) {
        g.fillStyle = shade(col, -0.35, 0.8);
        g.beginPath();
        g.ellipse(P * (0.2 + rnd() * 0.6), y + hgt / 2, hgt * 0.22, hgt * 0.14, 0, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = "rgba(255,255,255,0.07)";
      g.fillRect(0, y, P, m);
    }
  },

  water(g, col, P, rnd, v, deep = false) {
    const lg = g.createLinearGradient(0, 0, P, P);
    lg.addColorStop(0, shade(col, 0.05));
    lg.addColorStop(1, shade(col, -0.08));
    g.fillStyle = lg;
    g.fillRect(0, 0, P, P);
    g.strokeStyle = `rgba(255,255,255,${deep ? 0.08 : 0.13})`;
    g.lineWidth = Math.max(0.8, P * 0.025);
    g.lineCap = "round";
    for (let i = 0; i < 3; i++) {
      const x = rnd() * P * 0.7;
      const y = P * (0.15 + rnd() * 0.75);
      const w = P * (0.18 + rnd() * 0.15);
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + w / 2, y - P * 0.07, x + w, y);
      g.stroke();
    }
    if (deep) {
      g.fillStyle = "rgba(0,0,30,0.18)";
      g.fillRect(0, 0, P, P);
    }
  },

  deep(g, col, P, rnd, v) {
    PAINT.water(g, col, P, rnd, v, true);
  },

  lava(g, col, P, rnd) {
    g.fillStyle = shade(col, 0.15);
    g.fillRect(0, 0, P, P);
    for (let i = 0; i < 6; i++) {
      g.fillStyle = `rgba(45,12,4,${0.55 + rnd() * 0.25})`;
      g.beginPath();
      g.ellipse(rnd() * P, rnd() * P, P * (0.12 + rnd() * 0.14), P * (0.08 + rnd() * 0.1), rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "rgba(255,214,102,0.55)";
    for (let i = 0; i < 5; i++) g.fillRect(rnd() * P, rnd() * P, Math.max(1, P * 0.04), Math.max(1, P * 0.04));
  },

  grass(g, col, P, rnd) {
    g.fillStyle = shade(col, (rnd() - 0.5) * 0.06);
    g.fillRect(0, 0, P, P);
    if (rnd() < 0.5) {
      g.fillStyle = shade(col, -0.12, 0.5);
      g.beginPath();
      g.ellipse(rnd() * P, rnd() * P, P * 0.3, P * 0.2, rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    g.lineWidth = Math.max(0.7, P * 0.018);
    g.lineCap = "round";
    const blades = Math.min(90, Math.round((P * P) / 45));
    for (let i = 0; i < blades; i++) {
      const x = rnd() * P;
      const y = rnd() * P;
      const len = P * (0.05 + rnd() * 0.07);
      g.strokeStyle = rnd() < 0.55 ? shade(col, 0.15 + rnd() * 0.15, 0.7) : shade(col, -0.25, 0.7);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (rnd() - 0.5) * len * 0.8, y - len);
      g.stroke();
    }
  },

  cobble(g, col, P, rnd) {
    g.fillStyle = shade(col, -0.45);
    g.fillRect(0, 0, P, P);
    const n = 3;
    const s = P / n;
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        const cx = (c + 0.5 + (r % 2 ? 0.25 : -0.05) + (rnd() - 0.5) * 0.15) * s;
        const cy = (r + 0.5 + (rnd() - 0.5) * 0.15) * s;
        g.fillStyle = shade(col, (rnd() - 0.5) * 0.24);
        g.beginPath();
        g.ellipse(cx % P, cy, s * (0.4 + rnd() * 0.06), s * (0.36 + rnd() * 0.06), rnd(), 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "rgba(255,255,255,0.08)";
        g.beginPath();
        g.ellipse(cx % P - s * 0.08, cy - s * 0.1, s * 0.18, s * 0.1, 0, 0, Math.PI * 2);
        g.fill();
      }
  },

  rubble(g, col, P, rnd) {
    g.fillStyle = shade(col, -0.15);
    g.fillRect(0, 0, P, P);
    speckle(g, P, rnd, Math.min(50, (P * P) / 80), 0.08);
    for (let i = 0; i < 7; i++) {
      const x = rnd() * P;
      const y = rnd() * P;
      const s = P * (0.06 + rnd() * 0.1);
      g.fillStyle = shade(col, (rnd() - 0.4) * 0.4);
      g.beginPath();
      g.moveTo(x, y - s);
      g.lineTo(x + s, y - s * 0.2);
      g.lineTo(x + s * 0.5, y + s * 0.8);
      g.lineTo(x - s * 0.7, y + s * 0.5);
      g.closePath();
      g.fill();
    }
  },

  rug(g, col, P, rnd) {
    g.fillStyle = col;
    g.fillRect(0, 0, P, P);
    speckle(g, P, rnd, Math.min(40, (P * P) / 100), 0.05);
    g.strokeStyle = "rgba(255,214,150,0.28)";
    g.lineWidth = Math.max(1, P * 0.03);
    g.beginPath();
    g.moveTo(P / 2, 0);
    g.lineTo(P, P / 2);
    g.lineTo(P / 2, P);
    g.lineTo(0, P / 2);
    g.closePath();
    g.stroke();
    g.fillStyle = "rgba(255,214,150,0.22)";
    g.beginPath();
    g.arc(P / 2, P / 2, P * 0.08, 0, Math.PI * 2);
    g.fill();
  },

  stairs(g, col, P) {
    g.fillStyle = col;
    g.fillRect(0, 0, P, P);
    const n = 4;
    for (let i = 0; i < n; i++) {
      const y = (i * P) / n;
      const lg = g.createLinearGradient(0, y, 0, y + P / n);
      lg.addColorStop(0, "rgba(255,255,255,0.16)");
      lg.addColorStop(1, "rgba(0,0,0,0.3)");
      g.fillStyle = lg;
      g.fillRect(0, y, P, P / n);
    }
  },

  window(g, col, P) {
    g.fillStyle = shade(col, -0.5);
    g.fillRect(0, 0, P, P);
    const m = P * 0.12;
    g.fillStyle = col;
    g.fillRect(m, m, P - 2 * m, P - 2 * m);
    g.strokeStyle = "rgba(255,255,255,0.35)";
    g.lineWidth = Math.max(1, P * 0.04);
    g.beginPath();
    g.moveTo(m + P * 0.1, P - m - P * 0.1);
    g.lineTo(P - m - P * 0.1, m + P * 0.1);
    g.stroke();
    g.fillStyle = shade(col, -0.5);
    g.fillRect(P / 2 - P * 0.025, m, P * 0.05, P - 2 * m);
    g.fillRect(m, P / 2 - P * 0.025, P - 2 * m, P * 0.05);
  },

  plain(g, col, P, rnd) {
    g.fillStyle = col;
    g.fillRect(0, 0, P, P);
    speckle(g, P, rnd, Math.min(40, (P * P) / 100), 0.07);
  },
};

/** A cache of painted tiles for one pixel size at a time. */
export function tileCache() {
  const cache = new Map();
  let size = 0;
  return (style, color, variant, P) => {
    if (P !== size) {
      cache.clear();
      size = P;
    }
    const key = `${style}|${color}|${variant}`;
    let tile = cache.get(key);
    if (!tile) {
      tile = document.createElement("canvas");
      tile.width = tile.height = P;
      const g = tile.getContext("2d");
      (PAINT[style] ?? PAINT.plain)(g, color, P, rng(hashStr(key)), variant);
      cache.set(key, tile);
    }
    return tile;
  };
}
