// Writes icon.png (512x512, drawn in 256-unit space): a d20 on a battle-map grid. No dependencies: tiny rasterizer + PNG encoder.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ROOT } from "./pack-lib.mjs";

const N = 512;
const K = N / 256; // drawing units -> pixels
const SS = 4; // supersampling per axis
const px = new Float32Array(N * N * 4);

function blend(x, y, [r, g, b], a) {
  const i = (y * N + x) * 4;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
  px[i + 3] = px[i + 3] * (1 - a) + 255 * a;
}

/** Fill every pixel by coverage of `inside(x, y)` sampled SS×SS times. */
function fill(inside, color, alpha = 1) {
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) if (inside((x + (sx + 0.5) / SS) / K, (y + (sy + 0.5) / SS) / K)) hit++;
      if (hit) blend(x, y, color, (hit / (SS * SS)) * alpha);
    }
}

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const roundRect = (x0, y0, x1, y1, r) => (x, y) => {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
};
const poly = (pts) => (x, y) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const segment = (ax, ay, bx, by, w) => (x, y) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= (w / 2) ** 2;
};

const card = roundRect(8, 8, 248, 248, 44);
fill(card, hex("#15171c"));
// faint map grid inside the card
for (let k = 1; k < 8; k++) {
  const v = 8 + k * 30;
  fill((x, y) => card(x, y) && Math.abs(x - v) < 0.9, hex("#3b3f47"), 0.7);
  fill((x, y) => card(x, y) && Math.abs(y - v) < 0.9, hex("#3b3f47"), 0.7);
}
// d20: hexagon outline with the classic front triangle
const cx = 128;
const cy = 132;
const R = 92;
const P = Array.from({ length: 6 }, (_, i) => [cx + R * Math.sin((i * Math.PI) / 3), cy - R * Math.cos((i * Math.PI) / 3)]);
fill(poly(P.map(([x, y]) => [x + 4, y + 6])), [0, 0, 0], 0.45); // shadow
fill(poly(P), hex("#b7322c"));
const tri = [
  [cx, cy - R * 0.62],
  [cx + R * 0.62, cy + R * 0.42],
  [cx - R * 0.62, cy + R * 0.42],
];
fill(poly(tri), hex("#d24a3f"));
const edges = [
  [tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]],
  [P[0], tri[0]], [P[1], tri[1]], [P[2], tri[1]], [P[3], tri[1]], [P[3], tri[2]], [P[4], tri[2]], [P[5], tri[0]], [P[5], tri[2]], [P[1], tri[0]],
];
for (const [[ax, ay], [bx, by]] of edges) fill(segment(ax, ay, bx, by, 3.2), hex("#f4c7bf"), 0.75);
for (let i = 0; i < 6; i++) fill(segment(...P[i], ...P[(i + 1) % 6], 4), hex("#f4c7bf"), 0.9);
// gold token dot (the player) in the corner
fill((x, y) => (x - 206) ** 2 + (y - 206) ** 2 <= 22 ** 2, hex("#3b82f6"));
fill((x, y) => { const d = (x - 206) ** 2 + (y - 206) ** 2; return d <= 22 ** 2 && d >= 17 ** 2; }, hex("#93c5fd"));

// PNG encode (RGBA, filter 0)
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N * 4; x++) raw[y * (N * 4 + 1) + 1 + x] = Math.round(Math.max(0, Math.min(255, px[y * N * 4 + x])));
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
fs.writeFileSync(path.join(ROOT, "icon.png"), png);
process.stderr.write(`icon.png ${png.length} bytes\n`);
