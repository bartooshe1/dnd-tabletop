import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpec, parseExpr, rollSpec, rollText, DiceError } from "../engine/dice.js";

test("notation and labels", () => {
  assert.deepEqual(parseSpec("1d20+5 atk, 1d8+3 dmg"), [
    { expr: "1d20+5", label: "atk" },
    { expr: "1d8+3", label: "dmg" },
  ]);
  assert.deepEqual(parseSpec("d20"), [{ expr: "d20", label: "" }]);
  assert.deepEqual(parseSpec("1d8 + 2d6 + 3 sneak attack")[0], { expr: "1d8+2d6+3", label: "sneak attack" });
  assert.deepEqual(parseExpr("2d6-1"), [
    { sign: 1, count: 2, sides: 6 },
    { sign: -1, value: 1 },
  ]);
});

test("repeat syntax", () => {
  const items = parseSpec("4*(1d20+2) init");
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => i.label), ["init 1", "init 2", "init 3", "init 4"]);
  assert.ok(items.every((i) => i.expr === "1d20+2"));
  assert.equal(parseSpec("3x(1d6)").length, 3);
});

test("validation", () => {
  const bad = (s, re) => assert.throws(() => rollSpec(s), (e) => e instanceof DiceError && re.test(e.message), s);
  bad("1d7", /d7 isn't a die/);
  bad("21d6", /1 to 20 dice/);
  bad("0d6", /1 to 20 dice/);
  bad("1d20+101", /out of range/);
  bad("1d20-101", /out of range/);
  bad("", /no dice/);
  bad("five", /can't read/);
  bad("5", /has no dice/);
  bad("21*(1d6)", /repeat 21/);
  bad("1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6, 1d6", /max 20/);
  assert.throws(() => rollSpec("2d6", "adv"), /advantage needs a 1d20/);
});

test("bounds over many rolls (crypto.randomInt)", () => {
  for (const sides of [4, 6, 8, 10, 12, 20, 100]) {
    const seen = new Set();
    for (let i = 0; i < 3000; i++) {
      const [r] = rollSpec(`1d${sides}`);
      const v = r.groups[0].rolls[0];
      assert.ok(v >= 1 && v <= sides, `d${sides} gave ${v}`);
      seen.add(v);
    }
    assert.equal(seen.size, sides, `every face of d${sides} shows up`);
  }
  for (let i = 0; i < 500; i++) {
    const [r] = rollSpec("3d6+2");
    assert.ok(r.total >= 5 && r.total <= 20);
    assert.equal(r.total, r.groups[0].rolls.reduce((a, b) => a + b, 0) + 2);
  }
});

test("advantage keeps the higher, disadvantage the lower; both shown", () => {
  const seq = (vals) => () => vals.shift();
  const [adv] = rollSpec("1d20+5 atk", "adv", seq([7, 14]));
  assert.equal(adv.total, 19);
  assert.deepEqual(adv.groups[0].pair, [7, 14]);
  assert.equal(rollText(adv), "atk 1d20+5 (adv): [7|14]+5 = 19");
  const [dis] = rollSpec("1d20+5", "dis", seq([7, 14]));
  assert.equal(dis.total, 12);
  // mode only applies to 1d20 groups in a multi-roll call
  const both = rollSpec("1d20+5 atk, 1d8+3 dmg", "adv", seq([3, 18, 6]));
  assert.equal(both[0].mode, "adv");
  assert.equal(both[1].mode, null);
  assert.equal(both[1].total, 9);
});

test("result text and natural 20 / 1", () => {
  const seq = (vals) => () => vals.shift();
  assert.equal(rollText(rollSpec("1d20+5 atk", null, seq([14]))[0]), "atk 1d20+5: [14]+5 = 19");
  assert.equal(rollText(rollSpec("1d20+5", null, seq([20]))[0]), "1d20+5: [20]+5 = 25 NAT 20");
  assert.equal(rollText(rollSpec("1d20-1", null, seq([1]))[0]), "1d20-1: [1]-1 = 0 NAT 1");
  assert.equal(rollText(rollSpec("2d6+1d4+3 dmg", null, seq([2, 5, 4]))[0]), "dmg 2d6+1d4+3: [2,5]+[4]+3 = 14");
  assert.equal(rollSpec("1d100", null, seq([100]))[0].nat, null, "only d20s are natural 20s");
});
