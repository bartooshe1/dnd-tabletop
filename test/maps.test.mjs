// draw round-trip, built-in layouts, saved rooms, generators
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { table, tmpDir } from "./helpers.mjs";
import { toAscii } from "../engine/ascii.js";
import { builtinLayouts } from "../engine/rooms.js";
import { generate, components, GENERATORS } from "../engine/generators.js";
import { DEFAULT_TERRAIN } from "../engine/terrain.js";

const WALK = (t) => t !== null && !(DEFAULT_TERRAIN[t]?.blocking ?? true);

test("draw: default legend, extra legend, tokens, unknown chars", () => {
  const t = table();
  const r = t.ok("draw ~=water w=wolf\n#####\n#.@~#\n#w.+#\n#####");
  assert.match(r.info.join(), /created map 'Map 1' 5x4/);
  assert.equal(t.map().cols, 5);
  assert.equal(t.map().rows, 4);
  assert.equal(t.at("2x4").terrain, "water");
  assert.equal(t.at("3x4").terrain, "door");
  assert.equal(t.at("2x3").token, "player1");
  assert.equal(t.at("2x3").terrain, "floor", "tokens stand on the drawing's base terrain");
  assert.equal(t.at("3x2").token, "wolf1");
  const bad = t.fail("draw\n#?#\n#x#");
  assert.match(bad.errors[0], /unknown char '\?' \(first at 1x2\).*unknown char 'x'/);
  t.ok("draw\n  #\n ##");
  assert.equal(t.at("1x1").terrain, null, "space means nothing");
});

test("draw round-trip: toAscii output draws back to the same map", () => {
  const t = table();
  t.ok('new "R" 9x6, gen dungeon 9x6 seed=3, 1x1-water, 2x2-chest, 6x9-tree');
  const map = t.map();
  // put a couple of tokens on floor cells
  const floors = [];
  map.terrain.forEach((row, r) => row.forEach((tid, c) => tid === "floor" && floors.push(`${r + 1}x${c + 1}`)));
  t.ok(`${floors[0]}-player, ${floors[1]}-wolf`);
  const before = structuredClone(t.map());
  const { legend, rows } = toAscii(t.map(), t.c);
  t.ok(`draw ${legend}\n${rows.join("\n")}`);
  const after = t.map();
  assert.deepEqual(after.terrain, before.terrain);
  assert.deepEqual(after.tokens, before.tokens);
});

test("built-in layouts: 12, sane sizes, each one walkable and connected", () => {
  const all = builtinLayouts();
  assert.equal(all.length, 12);
  const ids = all.map((l) => l.id).sort();
  assert.deepEqual(ids, ["alley", "cave_chamber", "cellar", "crypt", "forest_clearing", "market_square", "prison_cells", "small_chamber", "smithy", "tavern", "temple", "throne_room"]);
  for (const l of all) {
    assert.ok(l.cols >= 5 && l.cols <= 20 && l.rows >= 5 && l.rows <= 16, `${l.id} is room-scale`);
    assert.ok(l.description.length > 10, `${l.id} has a description`);
    assert.equal(l.tokens.length, 0, `${l.id} is terrain only`);
    const comps = components(l.terrain, WALK);
    // locked prison doors split cells off by design; everything else is one region
    if (l.id !== "prison_cells") assert.equal(comps.length, 1, `${l.id} walkable area is connected`);
  }
});

test("load replaces the active map; load at RxC embeds with offset; misfit is an error", () => {
  const t = table();
  t.ok('new "Inn" 20x16, 1x1-wall');
  t.ok("load small chamber at 3x4");
  assert.equal(t.map().cols, 20, "embedding keeps the map size");
  assert.equal(t.at("3x4").terrain, "wall");
  assert.equal(t.at("3x7").terrain, "door", "the chamber's top door (1x4) lands at 3x7");
  assert.equal(t.at("1x1").terrain, "wall", "outside the room is untouched");
  assert.match(t.fail("load tavern at 10x10").errors[0], /doesn't fit.*rows 10-19, cols 10-23/);
  t.ok("load tavern");
  assert.deepEqual([t.map().cols, t.map().rows, t.map().name], [14, 10, "Inn"]);
  assert.match(t.fail("load dragon lair").errors[0], /no room 'dragon lair'/);
  const fresh = table();
  fresh.ok("load crypt");
  assert.equal(fresh.map().name, "Crypt", "with no map, load creates one named after the room");
});

test("save stores terrain (optionally tokens), fuzzy load, saving again replaces", () => {
  const dir = tmpDir();
  const t = table({ roomsDir: dir });
  t.ok('new "Inn" 8x6, 2x2-wall, 3x3-barkeep, tok barkeep1 name=Bram hp=9/9, 4x4-player');
  assert.match(t.ok('save "The Midnight Inn"').info.join(), /saved the_midnight_inn/);
  assert.ok(fs.existsSync(path.join(dir, "the_midnight_inn.json")));
  assert.match(t.ok("rooms").info[0], /saved: the_midnight_inn 8x6/);
  t.ok('new "Elsewhere" 10x10, load midnight inn');
  assert.equal(t.at("2x2").terrain, "wall");
  assert.equal(t.at("3x3").token, null, "terrain only by default");
  t.ok('use "Inn", save "The Midnight Inn" with tokens');
  t.ok('use "Elsewhere", load the midnight inn');
  const id = t.at("3x3").token;
  assert.ok(id?.startsWith("barkeep"));
  assert.equal(t.c.tokens[id].name, "Bram");
  assert.equal(t.at("4x4").token, "player1", "the player is reused, not duplicated");
  t.ok('use "Inn", 2x2-floor, save "The Midnight Inn"');
  t.ok('use "Elsewhere", load midnight');
  assert.equal(t.at("2x2").terrain, "floor", "saving again replaced the room");
  assert.match(t.fail('save "Tavern"').errors[0], /built-in room/);
});

test("a failed batch does not save a room", () => {
  const dir = tmpDir();
  const t = table({ roomsDir: dir });
  t.ok('new "A" 6x6');
  t.fail('save "Oops", 99x99-wall');
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.match(t.fail("load oops").errors[0], /no room/);
});

for (const kind of GENERATORS) {
  test(`gen ${kind}: deterministic, connected, in bounds, feature list`, () => {
    for (const [cols, rows] of [
      [5, 5],
      [10, 10],
      [30, 20],
      [20, 8],
      [8, 20],
      [60, 60],
    ]) {
      for (const seed of [1, 42, 999]) {
        const a = generate(kind, cols, rows, { seed });
        const b = generate(kind, cols, rows, { seed });
        assert.deepEqual(a, b, "same seed, same map");
        assert.equal(a.terrain.length, rows);
        assert.ok(a.terrain.every((r) => r.length === cols));
        const comps = components(a.terrain, WALK);
        assert.equal(comps.length, 1, `${kind} ${cols}x${rows} seed ${seed} is one connected region`);
        assert.ok(comps[0].length >= 4, "has room to play");
        assert.ok(a.features.length > 0);
        // every feature cell (room sizes after "center RxC" are WxH, not cells) is on the map and walkable
        const cellsOnly = a.features.replace(/(center \d+x\d+) \d+x\d+/g, "$1");
        for (const m of cellsOnly.matchAll(/(\d+)x(\d+)/g)) {
          const r = Number(m[1]) - 1;
          const c = Number(m[2]) - 1;
          assert.ok(r >= 0 && r < rows && c >= 0 && c < cols, `${m[0]} in bounds (${kind} ${cols}x${rows})`);
          assert.ok(WALK(a.terrain[r][c]), `${m[0]} walkable (${a.terrain[r][c]})`);
        }
      }
    }
    assert.notDeepEqual(generate(kind, 20, 14, { seed: 1 }).terrain, generate(kind, 20, 14, { seed: 2 }).terrain);
  });
}

test("gen via map: min size error, reports seed and features, dungeon feature cells are floor", () => {
  const t = table();
  assert.match(t.fail("gen dungeon 4x9").errors[0], /needs at least 5x5/);
  assert.match(t.fail("gen castle 10x10").errors[0], /unknown generator 'castle'/);
  const r = t.ok('new "D" 20x14, gen dungeon 20x14 rooms=4 seed=42');
  const info = r.info.join();
  assert.match(info, /seed 42; r1 center \d+x\d+ \d+x\d+/);
  for (const m of info.matchAll(/center (\d+x\d+)/g)) assert.equal(t.at(m[1]).terrain, "floor", `${m[1]} is a room floor`);
  const doors = /doors ([\dx,]+)/.exec(info);
  if (doors) for (const d of doors[1].split(",")) assert.equal(t.at(d).terrain, "door");
  const noDoors = t.ok("gen dungeon 20x14 rooms=4 seed=42 doors=false").info.join();
  assert.doesNotMatch(noDoors, /doors/);
  const s = t.ok("gen street 20x8 seed=5").info.join();
  for (const d of /doors ([\dx,]+)/.exec(s)[1].split(",")) assert.equal(t.at(d).terrain, "door");
  const randomSeed = t.ok("gen cave 20x14").info.join();
  assert.match(randomSeed, /seed \d+/, "a random seed is reported so the map can be reproduced");
});
