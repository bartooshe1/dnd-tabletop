// Initiative: the `init` map command, turn passing, rounds, removals, and what the UI may see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { table } from "./helpers.mjs";
import { buildMapView, mapText, tokenListText } from "../engine/view.js";
import { activeMap } from "../engine/model.js";

const setup = () => {
  const t = table();
  t.ok('new "Den" 10x8, 4x3-player, tok player1 name=Aria hp=20/24, 5x5-wolf, 5x6-wolf, tok wolf1 hp=4/11, 2x2-barkeep');
  return t;
};

test("init sorts highest first, starts at the top, commas and spaces both work", () => {
  const t = setup();
  const res = t.ok("init player1=14, wolf1=17 wolf2 = 9");
  assert.deepEqual(t.c.init, { round: 1, current: "wolf1", order: [{ id: "wolf1", n: 17 }, { id: "player1", n: 14 }, { id: "wolf2", n: 9 }] });
  assert.match(res.info.join(";"), /initiative: wolf1 17, player1 14, wolf2 9; wolf1's turn/);
});

test("init next passes the turn and counts rounds", () => {
  const t = setup();
  t.ok("init player1=14 wolf1=17");
  assert.match(t.ok("init next").info[0], /round 1: player1's turn/);
  assert.match(t.ok("init next").info[0], /round 2: wolf1's turn/);
  assert.equal(t.c.init.round, 2);
});

test("adding, updating and removing keep whose turn it is", () => {
  const t = setup();
  t.ok("init player1=14 wolf1=17, init next");
  t.ok("init wolf2=20");
  assert.equal(t.c.init.current, "player1", "a late joiner doesn't steal the turn");
  assert.deepEqual(t.c.init.order.map((e) => e.id), ["wolf2", "wolf1", "player1"]);
  t.ok("init -player1");
  assert.equal(t.c.init.current, "wolf2", "removing the active entry passes to the next, wrapping");
  assert.equal(t.c.init.round, 2);
  assert.match(t.fail("init -barkeep1").errors[0], /not in the initiative order/);
  t.ok("init end");
  assert.equal(t.c.init, undefined);
});

test("a creature removed from the map leaves the order", () => {
  const t = setup();
  t.ok("init player1=14 wolf1=17 wolf2=3");
  t.ok("5x5-empty");
  assert.deepEqual(t.c.init.order.map((e) => e.id), ["player1", "wolf2"]);
  assert.equal(t.c.init.current, "player1");
});

test("errors: unknown tokens, bad syntax, next without an order; batches stay atomic", () => {
  const t = setup();
  assert.match(t.fail("init next").errors[0], /no initiative order/);
  assert.match(t.fail("init dragon1=20").errors[0], /no token 'dragon1'/);
  assert.match(t.fail("init wolf1 12").errors[0], /can't read 'wolf1' in init/);
  assert.match(t.fail("init").errors[0], /init needs entries/);
  t.fail("init wolf1=12, 99x99-wall");
  assert.equal(t.c.init, undefined);
});

test("UI payload: order with wound words only; the player keeps HP numbers", () => {
  const t = setup();
  t.ok("init player1=14 wolf1=17 barkeep1=2");
  const v = buildMapView(t.c, activeMap(t.c), { units: "metric" });
  assert.equal(v.init.round, 1);
  assert.equal(v.init.current, "wolf1");
  const [wolf, me, barkeep] = v.init.order;
  assert.equal(wolf.wound, "bloodied");
  assert.equal(wolf.hp, undefined);
  assert.equal(wolf.maxHp, undefined);
  assert.equal(me.hp, 20);
  assert.equal(me.name, "Aria");
  assert.equal(barkeep.side, "neutral");
  assert.doesNotMatch(JSON.stringify(v.init), /"hp":4|11/);
});

test("DM text lists the order with the active entry starred", () => {
  const t = setup();
  t.ok("init player1=14 wolf1=17, init next");
  const map = activeMap(t.c);
  assert.match(tokenListText(t.c, map), /\ninitiative round 1: wolf1 17, player1 14\*$/);
  assert.match(mapText(t.c, map, "metric"), /initiative round 1: wolf1 17, player1 14\*/);
});
