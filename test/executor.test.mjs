import { test } from "node:test";
import assert from "node:assert/strict";
import { table } from "./helpers.mjs";

test("terrain vs tokens; auto-numbering reports ids", () => {
  const t = table();
  const res = t.ok('new "Room" 10x8, 1x1..1x4-wall, 4x3-player, 5x5-wolf, 5x6-wolf');
  assert.match(res.info.join(";"), /player1 4x3/);
  assert.match(res.info.join(";"), /wolf1 5x5/);
  assert.match(res.info.join(";"), /wolf2 5x6/);
  assert.equal(t.at("1x4").terrain, "wall");
  assert.equal(t.at("4x3").token, "player1");
  assert.equal(t.c.tokens.player1.side, "player");
  assert.equal(t.c.tokens.wolf1.side, "hostile");
  assert.equal(t.c.tokens.wolf1.type, "wolf");
});

test("batches are atomic and report every error with index and hint", () => {
  const t = table();
  t.ok('new "Room" 10x8, 4x3-player, 2x2-wall');
  const before = JSON.stringify(t.c);
  const res = t.fail("5x5-wolf, 7x9 > 3x3, 20x20-wall, 2x3 > 2x2, 1x1..1x2-wetfloor");
  assert.equal(JSON.stringify(t.c), before, "nothing applied");
  const e = res.errors.join("\n");
  assert.match(e, /#2 .*no token at 7x9 \(tokens nearby: .*player1 at 4x3/);
  assert.match(e, /#3 .*20x20 is off the map \(map is 10x8 W×H: rows 1-8, cols 1-10\)/);
  assert.match(e, /#4 .*no token at 2x3/);
  assert.match(e, /#5 .*unknown terrain 'wetfloor', closest: floor.*type wetfloor glyph=💧 color=#4a6/);
  assert.equal(res.errors.length, 4);
});

test("move: occupied, blocking, force past blocking but never past a token", () => {
  const t = table();
  t.ok('new "Room" 10x8, 4x3-player, 4x4-wall, 4x5-wolf');
  assert.match(t.fail("4x3 > 4x5").errors[0], /4x5 has wolf1/);
  assert.match(t.fail("player1 > 4x4").errors[0], /4x4 is wall \(blocks movement\).*>!/);
  t.ok("player1 >! 4x4");
  assert.equal(t.where("player1"), "4x4");
  assert.equal(t.at("4x4").terrain, "wall", "moving never alters terrain");
  assert.match(t.fail("player1 >! 4x5").errors[0], /4x5 has wolf1/);
  t.ok("4x4 > 8x10");
  assert.equal(t.where("player1"), "8x10");
});

test("'4x3 > 4x8' equals '4x3-empty, 4x8-player1' (stats kept)", () => {
  const a = table();
  const b = table();
  for (const t of [a, b]) t.ok('new "Room" 10x8, 4x3-player, tok player1 hp=12/20 status=prone name=Aria, 6x6-wolf, tok wolf1 hp=5/11');
  a.ok("4x3 > 4x8, wolf1 > 7x7");
  b.ok("4x3-empty, 4x8-player1, 6x6-empty, 7x7-wolf1");
  assert.deepEqual(a.c, b.c);
  assert.equal(a.c.tokens.wolf1.hp, 5);
  assert.equal(a.c.tokens.player1.name, "Aria");
});

test("empty vs clear", () => {
  const t = table();
  t.ok('new "Room" 6x6, 2x2-chest, 3x3-water, 3x3-wolf');
  t.ok("3x3-empty");
  assert.deepEqual(t.at("3x3"), { terrain: "water", token: null }, "empty removes the token first");
  assert.equal(t.c.tokens.wolf1, undefined, "removed hostile tokens are deleted");
  t.ok("3x3-empty, 2x2-empty");
  assert.equal(t.at("3x3").terrain, "floor", "then resets terrain to the map base");
  assert.equal(t.at("2x2").terrain, "floor");
  t.ok("4x4-wolf, 4x4-clear");
  assert.deepEqual(t.at("4x4"), { terrain: null, token: null });
  t.ok("1x1..2x2-wall, 1x1..2x2-empty");
  assert.equal(t.at("1x2").terrain, "floor");
});

test("players and allies survive leaving the board; player reuses player1 across scenes", () => {
  const t = table();
  t.ok('new "Inn" 8x8, 2x2-player, tok player1 hp=9/12, 3x3-tessa, tok tessa side=ally hp=6/8');
  t.ok('new "Road" 10x6, 3x3-player, 3x4-tessa');
  assert.equal(t.where("player1"), "3x3");
  assert.equal(t.where("tessa1"), "3x4");
  assert.equal(t.c.tokens.player1.hp, 9, "HP followed the character");
  assert.equal(t.c.tokens.tessa1.hp, 6);
  assert.equal(t.c.maps.find((m) => m.name === "Inn").tokens.flat().filter(Boolean).length, 0, "they left the old map");
  t.ok("3x3-empty");
  assert.ok(t.c.tokens.player1, "player kept off-board");
  t.ok("5x5-player");
  assert.equal(t.where("player1"), "5x5");
  t.ok("6x6-player");
  assert.equal(t.where("player2"), "6x6", "a second player on the same map gets a new id");
});

test("explicit ids: create, refuse duplicates, move between maps", () => {
  const t = table();
  t.ok('new "A" 6x6, 2x2-wolf3');
  assert.ok(t.c.tokens.wolf3);
  assert.match(t.fail("4x4-wolf3").errors[0], /already at 2x2.*wolf3 > 4x4/);
  assert.match(t.fail("2x2..2x3-wolf3").errors[0], /can't put one token/);
  t.ok('new "B" 6x6, 1x1-wolf3');
  assert.equal(t.where("wolf3"), "1x1");
  assert.match(t.fail('use "A", wolf3 > 3x3').errors[0], /not on this map \(it's on 'B'\)/);
});

test("ranges of creatures, occupied placement", () => {
  const t = table();
  t.ok('new "A" 8x8, 3x2..3x4-skeleton');
  assert.deepEqual([t.at("3x2").token, t.at("3x3").token, t.at("3x4").token], ["skeleton1", "skeleton2", "skeleton3"]);
  assert.match(t.fail("3x3-wolf").errors[0], /3x3 has skeleton2/);
  t.ok("3x3-empty, 4x4-skeleton");
  assert.equal(t.at("4x4").token, "skeleton4", "a token removed in this batch keeps its id until the batch ends");
  t.ok("4x4-empty");
  t.ok("5x5-skeleton");
  assert.equal(t.at("5x5").token, "skeleton2", "afterwards the lowest free number is reused");
});

test("tok: hp forms, relative changes report the new value, status add/remove, side aliases", () => {
  const t = table();
  t.ok('new "A" 6x6, 2x2-goblin');
  t.ok("tok goblin1 hp=7");
  assert.deepEqual([t.c.tokens.goblin1.hp, t.c.tokens.goblin1.maxHp], [7, 7]);
  const r = t.ok("tok goblin hp=-3");
  assert.match(r.info.join(), /goblin1 hp 4\/7/);
  t.ok("tok goblin1 hp=+10");
  assert.equal(t.c.tokens.goblin1.hp, 7, "clamped to max");
  t.ok("tok goblin1 hp=-99");
  assert.equal(t.c.tokens.goblin1.hp, 0, "clamped to 0");
  t.ok("tok goblin1 status=prone,poisoned");
  t.ok("tok goblin1 status=+grappled,-prone");
  assert.deepEqual(t.c.tokens.goblin1.status, ["poisoned", "grappled"]);
  t.ok("tok goblin1 status=none side=friend");
  assert.deepEqual(t.c.tokens.goblin1.status, []);
  assert.equal(t.c.tokens.goblin1.side, "ally");
  assert.ok(t.fail("tok goblin1 side=purple").errors[0].includes("side=player|ally|neutral|hostile"));
  assert.ok(t.fail("tok goblin1 mood=angry").errors[0].includes("unknown token property"));
  const nb = table();
  nb.ok('new "A" 6x6');
  assert.match(nb.fail("tok wolf1 hp=-3").errors[0], /no token 'wolf1'/);
});

test("NPC library entries default to neutral", () => {
  const t = table();
  t.ok('new "A" 6x6, 2x2-barkeep, 2x3-guard, 2x4-orc, 2x5-beholder');
  assert.equal(t.c.tokens.barkeep1.side, "neutral");
  assert.equal(t.c.tokens.guard1.side, "neutral");
  assert.equal(t.c.tokens.orc1.side, "hostile");
  assert.equal(t.c.tokens.beholder1.side, "hostile", "unknown names are valid creatures");
});

test("terrain aliases, plurals, unknown suggestions and the creature escape", () => {
  const t = table();
  t.ok('new "A" 6x6, 1x1-stone_wall, 1x2-wet_floor, 1x3-door_open, 1x4-barrels, 1x5-campfire');
  assert.deepEqual(["1x1", "1x2", "1x3", "1x4", "1x5"].map((c) => t.at(c).terrain), ["wall", "floor", "door", "barrel", "fire"]);
  assert.match(t.fail("2x2-stonewal").errors[0], /unknown terrain 'stonewal', closest: .*wall/);
  t.ok("2x2-doorman!");
  assert.equal(t.at("2x2").token, "doorman1");
  t.ok("type wetfloor glyph=💧 color=#4a6, 3x3-wetfloor");
  assert.equal(t.at("3x3").terrain, "wetfloor");
  assert.equal(t.c.types.wetfloor.color, "#4a6");
  t.ok("type lavaflow color=#f60 blocking, 3x4-lavaflow");
  assert.match(t.fail("3x5-player, player1 > 3x4").errors[0], /blocks movement/);
  assert.match(t.ok("types").info[0], /custom: wetfloor lavaflow\*/);
});

test("scenes: new, use (fuzzy), maps, caption, scale in meters or feet", () => {
  const t = table();
  t.ok('new "The Crypt" 12x10, caption Cold air, dust');
  t.ok('new "Tavern" 14x10');
  assert.match(t.fail('new "tavern"').errors[0], /already exists/);
  t.ok("use crypt");
  assert.equal(t.c.active, "The Crypt");
  assert.equal(t.map().caption, "Cold air, dust");
  assert.match(t.ok("maps").info[0], /The Crypt\* 12x10, Tavern 14x10/);
  t.ok("scale 3");
  assert.equal(t.map().scale, 3);
  assert.match(t.fail("use dragon lair").errors[0], /no map 'dragon lair'/);
  assert.match(t.fail('new "Big" 61x10').errors[0], /max 60x60/);
  const imp = table({ units: "imperial" });
  imp.ok('new "A" 6x6, scale 5');
  assert.equal(imp.map().scale, 1.5, "5 ft is stored as 1.5 m");
});

test("commands without a map auto-create a default 16x12 map", () => {
  const t = table();
  const r = t.ok("4x3-player");
  assert.match(r.info[0], /created map 'Map 1' 16x12/);
  assert.equal(t.map().cols, 16);
  assert.equal(t.map().rows, 12);
});

test("detailed mode reports moves with distances", () => {
  const t = table({ detail: "detailed" });
  t.ok('new "A" 10x10, 1x1-player');
  assert.match(t.ok("player1 > 4x5").info.join(), /player1 1x1→4x5 6 m/);
  const imp = table({ detail: "detailed", units: "imperial" });
  imp.ok('new "A" 10x10, 1x1-player');
  assert.match(imp.ok("player1 > 4x5").info.join(), /20 ft/);
});

test("placing on blocking terrain is allowed with a note", () => {
  const t = table();
  t.ok('new "A" 6x6, 2x2-wall');
  assert.match(t.ok("2x2-ghost").info.join(), /note: ghost1 stands on wall at 2x2/);
});
