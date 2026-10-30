// wound words and the "no enemy HP numbers in UI data" guarantee
import { test } from "node:test";
import assert from "node:assert/strict";
import { woundWord } from "../engine/wounds.js";
import { buildMapView, mapText, tokenListText } from "../engine/view.js";
import { table } from "./helpers.mjs";

test("wound word thresholds, exact boundaries", () => {
  const cases = [
    [100, 100, "unhurt"],
    [51, 100, "hurt"],
    [50, 100, "bloodied"],
    [26, 100, "bloodied"],
    [25, 100, "badly wounded"],
    [11, 100, "badly wounded"],
    [10, 100, "near death"],
    [1, 100, "near death"],
    [0, 100, "down"],
    [2, 7, "near death"], // <= 2 hp
    [3, 7, "bloodied"],
    [2, 2, "unhurt"],
    [1, 2, "near death"],
    [5, undefined, null],
  ];
  for (const [hp, max, want] of cases) assert.equal(woundWord(hp, max), want, `${hp}/${max}`);
});

function walk(obj, fn, pathStr = "") {
  if (Array.isArray(obj)) obj.forEach((v, i) => walk(v, fn, `${pathStr}[${i}]`));
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) {
    fn(k, v, `${pathStr}.${k}`);
    walk(v, fn, `${pathStr}.${k}`);
  }
}

test("UI payload: player gets HP numbers, nobody else does", () => {
  const t = table();
  t.ok('new "A" 8x8, 2x2-player, tok player1 hp=17/23 name=Aria, 3x3-wolf, tok wolf1 hp=5/22 name=Greyback, 4x4-tessa, tok tessa1 side=ally hp=13/19, 5x5-barkeep, tok barkeep1 hp=41/42');
  const view = buildMapView(t.c, t.map(), { units: "metric" });
  const byId = Object.fromEntries(view.tokens.map((x) => [x.id, x]));
  assert.equal(byId.player1.hp, 17);
  assert.equal(byId.player1.maxHp, 23);
  assert.equal(byId.wolf1.wound, "badly wounded");
  assert.equal(byId.tessa1.wound, "hurt");
  assert.equal(byId.barkeep1.wound, "hurt");
  for (const id of ["wolf1", "tessa1", "barkeep1"]) {
    walk(byId[id], (k) => assert.ok(!/hp/i.test(k), `${id} payload has no ${k}`));
  }
  // numbers of non-player HP appear nowhere in the serialized payload
  const json = JSON.stringify(view.tokens.filter((x) => x.side !== "player"));
  for (const n of ["5", "22", "13", "19", "41", "42"]) assert.ok(!new RegExp(`\\b${n}\\b`).test(json.replace(/"(r|c)":\d+|"color":"[^"]*"/g, "")), `no ${n} in ${json}`);
});

test("text fallback shows wound words for others and numbers for the player", () => {
  const t = table();
  t.ok('new "A" 6x4, 2x2-player, tok player1 hp=5/9, 2x4-wolf, tok wolf1 hp=3/11');
  const txt = mapText(t.c, t.map(), "metric");
  assert.match(txt, /player1 2x2 5\/9/);
  assert.match(txt, /wolf1 2x4 bloodied/);
  assert.doesNotMatch(txt, /3\/11/);
  assert.match(txt, /1 sq = 1.5 m/);
  // Claude's own token list (DM screen) has the real numbers
  assert.match(tokenListText(t.c, t.map()), /wolf1 2x4 3\/11/);
});

test("empty view when there is no map", () => {
  const t = table();
  const { at, ...rest } = buildMapView(t.c, null, { units: "metric" });
  assert.equal(typeof at, "number");
  assert.deepEqual(rest, { v: 1, kind: "map", units: "metric", maps: 0, empty: true });
});

test("payload is compact: palette indexes, only types on the map", () => {
  const t = table();
  t.ok('new "A" 4x3, 1x1..1x4-wall, 2x2-water');
  const v = buildMapView(t.c, t.map(), { units: "metric" });
  assert.deepEqual(v.palette.map((p) => p.id).sort(), ["floor", "wall", "water"]);
  assert.equal(v.terrain.length, 3);
  assert.ok(v.terrain.flat().every((i) => Number.isInteger(i)));
});
