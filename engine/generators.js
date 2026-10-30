// Deterministic, always-connected map generators. Pure functions of (kind, size, options, seed).
// Output: { terrain: [[id|null]], base, features: "r1 center 4x6 5x4; doors 3x8,7x12" }
// Feature cells are RxC (1-based); feature sizes are WxH.
import { cellName } from "./model.js";

export const GENERATORS = ["dungeon", "cave", "clearing", "street"];
export const MIN_GEN = 5;

const WALKABLE = new Set(["floor", "door", "grass", "bush", "road", "rubble", "water"]);

/** mulberry32: small, fast, good enough for map layouts. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)); // inclusive
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}

const fill = (rows, cols, v) => Array.from({ length: rows }, () => Array(cols).fill(v));
const N4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const N8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const inside = (g, r, c) => r >= 0 && c >= 0 && r < g.length && c < g[0].length;

/** Connected components of walkable cells (4-neighbour). */
export function components(g, walkable = (t) => WALKABLE.has(t)) {
  const seen = fill(g.length, g[0].length, false);
  const comps = [];
  for (let r = 0; r < g.length; r++)
    for (let c = 0; c < g[0].length; c++) {
      if (seen[r][c] || !walkable(g[r][c])) continue;
      const comp = [];
      const stack = [[r, c]];
      seen[r][c] = true;
      while (stack.length) {
        const [y, x] = stack.pop();
        comp.push([y, x]);
        for (const [dy, dx] of N4) {
          const ny = y + dy;
          const nx = x + dx;
          if (inside(g, ny, nx) && !seen[ny][nx] && walkable(g[ny][nx])) {
            seen[ny][nx] = true;
            stack.push([ny, nx]);
          }
        }
      }
      comps.push(comp);
    }
  return comps.sort((a, b) => b.length - a.length);
}

/** Keep the largest walkable region; fill the rest with `filler`. */
function keepLargest(g, filler) {
  const comps = components(g);
  for (const comp of comps.slice(1)) for (const [r, c] of comp) g[r][c] = filler;
  return comps[0] ?? [];
}

function generateDungeon(cols, rows, opts, R) {
  const g = fill(rows, cols, "wall");
  const want = clampInt(opts.rooms, 1, 15, Math.max(1, Math.min(9, Math.round((cols * rows) / 50))));
  const doors = opts.doors === undefined ? true : !/^(0|false|no|off)$/i.test(String(opts.doors));
  const maxW = Math.max(3, Math.min(9, cols - 2));
  const maxH = Math.max(3, Math.min(7, rows - 2));
  const rooms = [];
  for (let attempt = 0; attempt < want * 60 && rooms.length < want; attempt++) {
    const w = R.int(3, maxW);
    const h = R.int(3, maxH);
    if (w > cols - 2 || h > rows - 2) continue;
    const x = R.int(1, cols - 1 - w);
    const y = R.int(1, rows - 1 - h);
    const clash = rooms.some((o) => x - 1 < o.x + o.w && x + w + 1 > o.x && y - 1 < o.y + o.h && y + h + 1 > o.y);
    if (!clash) rooms.push({ x, y, w, h });
  }
  if (!rooms.length) rooms.push({ x: 1, y: 1, w: cols - 2, h: rows - 2 });
  for (const rm of rooms) for (let r = rm.y; r < rm.y + rm.h; r++) for (let c = rm.x; c < rm.x + rm.w; c++) g[r][c] = "floor";
  const inRoom = (r, c) => rooms.some((rm) => r >= rm.y && r < rm.y + rm.h && c >= rm.x && c < rm.x + rm.w);
  const center = (rm) => ({ r: rm.y + Math.floor(rm.h / 2), c: rm.x + Math.floor(rm.w / 2) });
  const order = rooms.map((rm, i) => ({ rm, i })).sort((a, b) => center(a.rm).c - center(b.rm).c || center(a.rm).r - center(b.rm).r);
  const crossings = new Set();
  const carve = (a, b) => {
    const horizFirst = R() < 0.5;
    const path = [];
    let { r, c } = a;
    const stepTo = (tr, tc) => {
      while (r !== tr || c !== tc) {
        if (c !== tc) c += Math.sign(tc - c);
        else r += Math.sign(tr - r);
        path.push([r, c]);
      }
    };
    if (horizFirst) {
      stepTo(a.r, b.c);
      stepTo(b.r, b.c);
    } else {
      stepTo(b.r, a.c);
      stepTo(b.r, b.c);
    }
    for (const [y, x] of path) {
      if (g[y][x] === "wall" && !inRoom(y, x)) {
        if (N4.some(([dy, dx]) => inside(g, y + dy, x + dx) && inRoom(y + dy, x + dx))) crossings.add(`${y},${x}`);
        g[y][x] = "floor";
      }
    }
  };
  for (let k = 1; k < order.length; k++) carve(center(order[k - 1].rm), center(order[k].rm));
  if (order.length > 3) carve(center(order[0].rm), center(order[order.length - 1].rm));
  const doorCells = [];
  if (doors) {
    for (const key of crossings) {
      const [r, c] = key.split(",").map(Number);
      const t = (y, x) => (inside(g, y, x) ? g[y][x] : "wall");
      const ns = t(r - 1, c) === "wall" && t(r + 1, c) === "wall" && t(r, c - 1) !== "wall" && t(r, c + 1) !== "wall";
      const ew = t(r, c - 1) === "wall" && t(r, c + 1) === "wall" && t(r - 1, c) !== "wall" && t(r + 1, c) !== "wall";
      const nearDoor = doorCells.some(([y, x]) => Math.abs(y - r) + Math.abs(x - c) <= 1);
      if ((ns || ew) && !nearDoor) {
        g[r][c] = "door";
        doorCells.push([r, c]);
      }
    }
  }
  keepLargest(g, "wall");
  const feats = order.map(({ rm }, k) => {
    const ce = center(rm);
    return `r${k + 1} center ${cellName(ce.r, ce.c)} ${rm.w}x${rm.h}`;
  });
  if (doorCells.length) feats.push(`doors ${doorCells.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([r, c]) => cellName(r, c)).join(",")}`);
  return { terrain: g, base: "floor", features: feats.join("; ") };
}

function generateCave(cols, rows, opts, R) {
  const fillPct = clampInt(opts.fill, 30, 60, 45) / 100;
  let g;
  let region = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    g = fill(rows, cols, "wall");
    for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) g[r][c] = R() < fillPct ? "wall" : "floor";
    for (let it = 0; it < 5; it++) {
      const next = g.map((row) => [...row]);
      for (let r = 1; r < rows - 1; r++)
        for (let c = 1; c < cols - 1; c++) {
          const walls = N8.reduce((n, [dy, dx]) => n + (g[r + dy][c + dx] === "wall" ? 1 : 0), 0);
          next[r][c] = walls >= 5 || (g[r][c] === "wall" && walls >= 4) ? "wall" : "floor";
        }
      g = next;
    }
    region = keepLargest(g, "wall");
    if (region.length >= (rows - 2) * (cols - 2) * 0.3) break;
  }
  if (region.length < (rows - 2) * (cols - 2) * 0.3) {
    // tiny or unlucky maps: an open oval chamber
    g = fill(rows, cols, "wall");
    const cy = (rows - 1) / 2;
    const cx = (cols - 1) / 2;
    for (let r = 1; r < rows - 1; r++)
      for (let c = 1; c < cols - 1; c++) if (((r - cy) / Math.max(1, cy)) ** 2 + ((c - cx) / Math.max(1, cx)) ** 2 <= 1.05) g[r][c] = "floor";
    region = keepLargest(g, "wall");
  }
  // entrance: tunnel from the floor cell nearest an edge out through the border
  const feats = [];
  if (!/^(0|false|no|off)$/i.test(String(opts.entrance ?? "true"))) {
    let best = null;
    for (const [r, c] of region) {
      const d = Math.min(r, c, rows - 1 - r, cols - 1 - c);
      if (!best || d < best.d) best = { r, c, d };
    }
    if (best) {
      const dirs = [
        [best.r, 0, -1],
        [best.c, -1, 0],
        [rows - 1 - best.r, 0, 1],
        [cols - 1 - best.c, 1, 0],
      ];
      const [, dr, dc] = dirs.sort((a, b) => a[0] - b[0])[0];
      let r = best.r;
      let c = best.c;
      while (inside(g, r + dr, c + dc)) {
        r += dr;
        c += dc;
        g[r][c] = "floor";
      }
      feats.push(`entrance ${cellName(r, c)}`);
    }
  }
  if (!/^(0|false|no|off)$/i.test(String(opts.rubble ?? "true"))) {
    for (const [r, c] of region) if (R() < 0.03) g[r][c] = "rubble";
  }
  const spots = spread(region.filter(([r, c]) => g[r][c] === "floor"), 4, R);
  if (spots.length) feats.push(`open spots ${spots.map(([r, c]) => cellName(r, c)).join(",")}`);
  return { terrain: g, base: "floor", features: feats.join("; ") };
}

function generateClearing(cols, rows, opts, R) {
  const g = fill(rows, cols, "grass");
  const cy = (rows - 1) / 2;
  const cx = (cols - 1) / 2;
  const ry = Math.max(1.5, (rows / 2 - 1) * 0.9);
  const rx = Math.max(1.5, (cols / 2 - 1) * 0.9);
  const wobble = Array.from({ length: 8 }, () => R() * 0.3 - 0.15);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const ang = Math.atan2(r - cy, c - cx);
      const k = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * 8) % 8;
      const d = Math.sqrt(((r - cy) / ry) ** 2 + ((c - cx) / rx) ** 2) - wobble[k];
      const edge = r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
      if (edge || d > 1.05) g[r][c] = R() < 0.85 ? "tree" : "bush";
      else if (d > 0.85) g[r][c] = R() < 0.5 ? "bush" : "grass";
      else if (R() < 0.03) g[r][c] = "bush";
      else if (R() < 0.01) g[r][c] = "rubble";
    }
  const feats = [`clearing center ${cellName(Math.round(cy), Math.round(cx))}`];
  if (!/^(0|false|no|off)$/i.test(String(opts.path ?? "true"))) {
    const horizontal = cols >= rows;
    const len = horizontal ? cols : rows;
    const span = horizontal ? rows : cols;
    let at = Math.round((span - 1) / 2);
    const ends = [];
    for (let i = 0; i < len; i++) {
      if (i > 0 && i < len - 1 && R() < 0.25) {
        // carve the old lane on this step too, so the path never connects only diagonally
        const [r0, c0] = horizontal ? [at, i] : [i, at];
        g[r0][c0] = "road";
        at = Math.max(1, Math.min(span - 2, at + (R() < 0.5 ? -1 : 1)));
      }
      const [r, c] = horizontal ? [at, i] : [i, at];
      g[r][c] = "road";
      if (i === 0 || i === len - 1) ends.push(cellName(r, c));
    }
    feats.push(`path ends ${ends.join(",")}`);
  }
  keepLargest(g, "tree");
  return { terrain: g, base: "grass", features: feats.join("; ") };
}

function generateStreet(cols, rows, opts, R) {
  const horizontal = cols >= rows;
  const L = horizontal ? cols : rows; // along the street
  const S = horizontal ? rows : cols; // across the street
  const roadW = S >= 9 ? 3 : S >= 6 ? 2 : 1;
  const roadStart = Math.floor((S - roadW) / 2);
  const t = fill(S, L, "road"); // street-space grid: t[across][along]
  const doors = [];
  const blocks = [
    { from: 0, to: roadStart - 1, facing: roadStart - 1 },
    { from: roadStart + roadW, to: S - 1, facing: roadStart + roadW },
  ].filter((b) => b.to >= b.from);
  for (const b of blocks) {
    const depth = b.to - b.from + 1;
    let x = 0;
    while (x < L) {
      let w = Math.min(R.int(4, 7), L - x);
      if (L - x - w > 0 && L - x - w < 3) w = L - x; // absorb a short remainder
      for (let i = x; i < x + w; i++) for (let a = b.from; a <= b.to; a++) t[a][i] = "wall";
      if (depth >= 3 && w >= 3) {
        for (let i = x + 1; i <= x + w - 2; i++) for (let a = b.from + 1; a <= b.to - 1; a++) t[a][i] = "floor";
        const d = R.int(x + 1, x + w - 2);
        t[b.facing][d] = "door";
        doors.push([b.facing, d]);
      }
      x += w;
      if (x < L - 3 && R() < 0.35) x += 1; // alley: this column stays road
    }
  }
  // street clutter on the road edges, never in front of a door or an alley mouth
  if (roadW >= 2) {
    const front = new Set(doors.map(([a, i]) => `${a < roadStart ? roadStart : roadStart + roadW - 1},${i}`));
    for (const b of blocks) {
      const a = b.facing < roadStart ? roadStart : roadStart + roadW - 1;
      for (let i = 1; i < L - 1; i++) {
        if (front.has(`${a},${i}`) || t[b.facing][i] === "road" || R() > 0.08) continue;
        t[a][i] = R.pick(["barrel", "crate", "market_stall"]);
      }
    }
  }
  const g = horizontal ? t : Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => t[c][r]));
  keepLargest(g, "wall");
  const toCell = ([a, i]) => (horizontal ? cellName(a, i) : cellName(i, a));
  const roadDesc = horizontal ? `road rows ${roadStart + 1}-${roadStart + roadW}` : `road cols ${roadStart + 1}-${roadStart + roadW}`;
  const doorList = doors.filter(([a, i]) => (horizontal ? g[a][i] : g[i][a]) === "door").map(toCell);
  return { terrain: g, base: "road", features: `${roadDesc}; doors ${doorList.join(",")}` };
}

/** Pick up to n cells spread far apart (farthest-point sampling). */
function spread(cells, n, R) {
  if (!cells.length) return [];
  const out = [cells[Math.floor(R() * cells.length)]];
  while (out.length < n && out.length < cells.length) {
    let best = null;
    let bestD = -1;
    for (const cell of cells) {
      const d = Math.min(...out.map((o) => Math.max(Math.abs(o[0] - cell[0]), Math.abs(o[1] - cell[1]))));
      if (d > bestD) {
        bestD = d;
        best = cell;
      }
    }
    if (bestD < 3) break;
    out.push(best);
  }
  return out;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
}

export function generate(kind, cols, rows, opts = {}) {
  const R = rng(Number(opts.seed) || 0);
  switch (kind) {
    case "dungeon":
      return generateDungeon(cols, rows, opts, R);
    case "cave":
      return generateCave(cols, rows, opts, R);
    case "clearing":
      return generateClearing(cols, rows, opts, R);
    case "street":
      return generateStreet(cols, rows, opts, R);
    default:
      throw Object.assign(new Error(`unknown generator '${kind}'`), { hint: `kinds: ${GENERATORS.join(", ")}` });
  }
}
