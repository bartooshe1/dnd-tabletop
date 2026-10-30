// QR encoder for the LAN link. The fixtures below were verified to decode with jsQR 1.4.0
// (versions 1-10, byte mode, UTF-8) before being pinned here; any change to the output fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { qrMatrix, qrSvg } from "../cc/qr.js";

const hash = (m) => crypto.createHash("sha256").update(m.map((r) => r.map((b) => (b ? 1 : 0)).join("")).join("\n")).digest("hex");

test("pinned, decoder-verified output", () => {
  const lan = qrMatrix("http://192.168.1.145:47800/?t=ZYlsE40fGLDC8du252a_34h8hqGpDXCO");
  assert.equal(lan.length, 33, "version 4");
  assert.equal(hash(lan), "144a01840a321c2e8178e93940050da226c4b96c0bc04c1fa828c87cac8d43b5");
  const long = qrMatrix("z".repeat(210));
  assert.equal(long.length, 57, "version 10");
  assert.equal(hash(long), "b23bb91adab1b351bd96520db36e03383a46415efb81d9bcd72b2359bcf1d532");
});

test("structure: finder patterns, timing, dark module; versions grow with length; too long throws", () => {
  const m = qrMatrix("hi");
  assert.equal(m.length, 21);
  const finder = (r0, c0) => [0, 6].every((i) => [0, 1, 2, 3, 4, 5, 6].every((j) => m[r0 + i][c0 + j] && m[r0 + j][c0 + i]));
  assert.ok(finder(0, 0) && finder(0, 14) && finder(14, 0));
  for (let i = 8; i < 13; i++) assert.equal(m[6][i], i % 2 === 0);
  assert.equal(m[21 - 8][8], true);
  assert.ok(qrMatrix("x".repeat(60)).length > 21);
  assert.throws(() => qrMatrix("x".repeat(400)), /too long/);
  assert.match(qrSvg("hi"), /^<svg [^>]*viewBox="0 0 29 29"/);
});
