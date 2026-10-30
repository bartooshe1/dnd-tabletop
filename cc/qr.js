// Minimal QR code encoder (byte mode, error correction M, versions 1-10, best mask),
// written from the ISO/IEC 18004 algorithm so the LAN link can be shown as a QR without deps.
// qrSvg(text) -> "<svg ...>" ; qrMatrix(text) -> boolean[][] (true = dark)

const ECC_M = {
  // version: [ecCodewordsPerBlock, [blocks, dataCodewordsPerBlock]...]
  1: [10, [1, 16]],
  2: [16, [1, 28]],
  3: [26, [1, 44]],
  4: [18, [2, 32]],
  5: [24, [2, 43]],
  6: [16, [4, 27]],
  7: [18, [4, 31]],
  8: [22, [2, 38], [2, 39]],
  9: [22, [3, 36], [2, 37]],
  10: [26, [4, 43], [1, 44]],
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

// GF(256) with polynomial 0x11d
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const res = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ res.shift();
    res.push(0);
    for (let i = 0; i < degree; i++) res[i] ^= mul(gen[i + 1], factor);
  }
  return res;
}

function dataCapacity(v) {
  const [, ...groups] = ECC_M[v];
  return groups.reduce((s, [n, k]) => s + n * k, 0);
}

function encodeData(bytes, v) {
  const bits = [];
  const put = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, v <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCapacity(v) * 8;
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0; out.length < cap / 8; pad++) out.push(pad % 2 ? 0x11 : 0xec);
  return out;
}

function interleave(data, v) {
  const [ec, ...groups] = ECC_M[v];
  const blocks = [];
  let pos = 0;
  for (const [n, k] of groups) {
    for (let i = 0; i < n; i++) {
      const d = data.slice(pos, pos + k);
      pos += k;
      blocks.push({ d, e: rsRemainder(d, ec) });
    }
  }
  const out = [];
  const maxK = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxK; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

function baseMatrix(v) {
  const size = 17 + 4 * v;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, dark) => {
    m[r][c] = dark;
    fn[r][c] = true;
  };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(rr, cc, inRing || inCore);
      }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const al = ALIGN[v];
  for (const r of al)
    for (const c of al) {
      if ((r === 6 && c === 6) || (r === 6 && c === al.at(-1)) || (r === al.at(-1) && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  // reserve format and version areas
  for (let i = 0; i <= 8; i++) {
    if (!fn[8][i]) set(8, i, false);
    if (!fn[i][8]) set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, false);
    set(size - 1 - i, 8, false);
  }
  set(size - 8, 8, true); // dark module
  if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
    set(i, size - 11 + j, false);
    set(size - 11 + j, i, false);
  }
  return { m, fn, size };
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function bchBits(value, poly, polyLen) {
  let v = value << (polyLen - 1);
  for (let i = 31; i >= polyLen - 1; i--) if ((v >>> i) & 1) v ^= poly << (i - (polyLen - 1));
  return v;
}

function placeFormat(m, size, mask) {
  const data = (0b00 << 3) | mask; // ECC level M = 00
  const bits = ((data << 10) | bchBits(data, 0x537, 11)) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;
  // m[row][col]; the standard lists these as (x = col, y = row)
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6);
  m[8][8] = bit(7);
  m[8][7] = bit(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i);
  m[size - 8][8] = true;
}

function placeVersion(m, size, v) {
  if (v < 7) return;
  const bits = (v << 12) | bchBits(v, 0x1f25, 13);
  for (let i = 0; i < 18; i++) {
    const b = ((bits >>> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const c = size - 11 + (i % 3);
    m[a][c] = b;
    m[c][a] = b;
  }
}

function penalty(m, size) {
  let p = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = pass ? m[j][i] : m[i][j];
        const b = pass ? m[j - 1][i] : m[i][j - 1];
        if (a === b) run++;
        else {
          if (run >= 5) p += run - 2;
          run = 1;
        }
      }
      if (run >= 5) p += run - 2;
    }
  }
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) if (m[r][c] === m[r + 1][c] && m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c + 1]) p += 3;
  const pat = [true, false, true, true, true, false, true];
  for (let r = 0; r < size; r++)
    for (let c = 0; c + 7 <= size; c++) {
      const row = pat.every((x, k) => m[r][c + k] === x);
      const col = pat.every((x, k) => m[c + k][r] === x);
      const lightAround = (get) => [0, 1, 2, 3].every((k) => !get(k));
      if (row && (lightAround((k) => m[r][c - 1 - k]) || lightAround((k) => m[r][c + 7 + k]))) p += 40;
      if (col && (lightAround((k) => m[c - 1 - k]?.[r]) || lightAround((k) => m[c + 7 + k]?.[r]))) p += 40;
    }
  const dark = m.flat().filter(Boolean).length;
  p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return p;
}

export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let v = 1;
  while (v <= 10 && dataCapacity(v) < bytes.length + 2 + (v > 9 ? 1 : 0)) v++;
  if (v > 10) throw new Error("text too long for this QR encoder");
  const codewords = interleave(encodeData(bytes, v), v);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const { m, fn, size } = baseMatrix(v);
    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? size - 1 - vert : vert;
          if (fn[r][c]) continue;
          let dark = false;
          if (bitIdx < totalBits) dark = ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx++;
          m[r][c] = dark !== MASKS[mask](r, c);
        }
      }
    }
    placeFormat(m, size, mask);
    placeVersion(m, size, v);
    const score = penalty(m, size);
    if (!best || score < best.score) best = { m, score };
  }
  return best.m;
}

export function qrSvg(text, { scale = 6, margin = 4, dark = "#111", light = "#fff" } = {}) {
  const m = qrMatrix(text);
  const n = m.length + margin * 2;
  let d = "";
  m.forEach((row, r) => row.forEach((on, c) => on && (d += `M${c + margin} ${r + margin}h1v1h-1z`)));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * scale}" height="${n * scale}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
