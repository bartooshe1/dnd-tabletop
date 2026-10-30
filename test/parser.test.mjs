import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, splitCommands, parseCell, parseProps } from "../engine/parser.js";

const cmds = (t) => parse(t).map((p) => p.cmd ?? { error: p.error, hint: p.hint });
const one = (t) => {
  const p = parse(t);
  assert.equal(p.length, 1, `expected one command from ${t}`);
  return p[0].cmd ?? p[0];
};

test("cells are RxC, 1-based in text, 0-based in output", () => {
  assert.deepEqual(parseCell("4x3"), { r: 3, c: 2 });
  assert.deepEqual(parseCell(" 12 X 7 "), { r: 11, c: 6 });
  assert.equal(parseCell("4,3"), null);
});

test("place: single cell, range, case and whitespace", () => {
  assert.deepEqual(one("4x3-player"), { op: "place", from: { r: 3, c: 2 }, to: { r: 3, c: 2 }, range: false, what: "player", force: false });
  const r = one("1x1..1x4-wall");
  assert.deepEqual([r.from, r.to, r.range, r.what], [{ r: 0, c: 0 }, { r: 0, c: 3 }, true, "wall"]);
  assert.deepEqual(one("  5X5 -  Wolf "), one("5x5-wolf"));
  // reversed range corners are normalized
  const rev = one("3x4..1x1-floor");
  assert.deepEqual([rev.from, rev.to], [{ r: 0, c: 0 }, { r: 2, c: 3 }]);
  assert.equal(one("2x2-giant spider").what, "giant_spider");
  assert.equal(one("2x2-giant-spider").what, "giant_spider");
  assert.equal(one("2x2-doorman!").force, true);
});

test("move by cell or id, with force", () => {
  assert.deepEqual(one("4x3 > 4x8"), { op: "move", from: { r: 3, c: 2 }, to: { r: 3, c: 7 }, force: false });
  assert.deepEqual(one("player1>4x8"), { op: "move", from: { id: "player1" }, to: { r: 3, c: 7 }, force: false });
  assert.equal(one("wolf2 >! 1x1").force, true);
  assert.equal(one("WOLF2 > 1X1").from.id, "wolf2");
});

test("separators: commas, semicolons, newlines", () => {
  const out = cmds("1x1-wall, 1x2-wall; 1x3-wall\n1x4-wall");
  assert.equal(out.length, 4);
  assert.ok(out.every((c) => c.op === "place"));
});

test("commas inside values and captions are kept", () => {
  const out = cmds("tok snik1 name=Snik hp=7/7 status=prone,poisoned side=ally, 4x4-wolf");
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { op: "tok", id: "snik1", props: { name: "Snik", hp: "7/7", status: "prone,poisoned", side: "ally" } });
  const cap = cmds("caption Night falls, new dangers wait; 2x2-wall");
  assert.equal(cap[0].text, "Night falls, new dangers wait");
  assert.equal(cap[1].op, "place");
  assert.equal(one('caption "A, B; C"').text, "A, B; C");
  // a real command after a caption is not swallowed
  const mixed = cmds("load tavern, caption The Prancing Pony, 6x4-player, 3x9-barkeep");
  assert.deepEqual(mixed.map((c) => c.op), ["load", "caption", "place", "place"]);
  assert.equal(mixed[1].text, "The Prancing Pony");
  // place values never glue: a stray piece is its own (bad) command
  assert.equal(parse("1x1-wall, nonsense here, 2x2-wall").length, 3);
});

test("scene commands", () => {
  assert.deepEqual(one('new "Crypt" 16x12'), { op: "new", name: "Crypt", size: { cols: 16, rows: 12 } });
  assert.deepEqual(one("new Crypt"), { op: "new", name: "Crypt", size: null });
  assert.deepEqual(one('use "The Crypt"'), { op: "use", name: "The Crypt" });
  assert.deepEqual(one("use the crypt"), { op: "use", name: "the crypt" });
  assert.deepEqual(one("scale 1.5"), { op: "scale", value: 1.5 });
  assert.deepEqual(one("scale 3 m"), { op: "scale", value: 3 });
  assert.equal(one("scale -1").error, "scale needs a positive number");
  assert.deepEqual(one("maps"), { op: "maps" });
  assert.deepEqual(one("types"), { op: "types" });
  assert.deepEqual(one("rooms"), { op: "rooms" });
});

test("type definitions", () => {
  assert.deepEqual(one("type wetfloor glyph=💧 color=#4a6 blocking"), { op: "type", id: "wetfloor", props: { glyph: "💧", color: "#4a6" }, blocking: true });
  assert.equal(one("type mud color=#553").blocking, undefined);
});

test("draw with inline and next-line legend, ends at blank line", () => {
  const p = parse("draw ~=water T=table\n#####\n#.~T#\n#####\n\n2x2-player");
  assert.equal(p.length, 2);
  assert.deepEqual(p[0].cmd, { op: "draw", legend: { "~": "water", T: "table" }, rows: ["#####", "#.~T#", "#####"] });
  assert.equal(p[1].cmd.op, "place");
  const q = parse("draw\n~=water w=wolf\n###\n#w#\n###");
  assert.deepEqual(q[0].cmd.legend, { "~": "water", w: "wolf" });
  assert.equal(q[0].cmd.rows.length, 3);
  // rows keep leading spaces (nothing) and commas (grass) untouched
  const r = parse('new "A" 5x5; draw\n  ,,,\n #.,\n');
  assert.deepEqual(r[1].cmd.rows, ["  ,,,", " #.,"]);
  assert.match(parse("draw, 1x1-wall")[0].error, /last command on its line/);
});

test("load, save, gen", () => {
  assert.deepEqual(one("load tavern"), { op: "load", name: "tavern", at: null });
  assert.deepEqual(one("load tavern at 3x3"), { op: "load", name: "tavern", at: { r: 2, c: 2 } });
  assert.deepEqual(one("load midnight inn"), { op: "load", name: "midnight inn", at: null });
  assert.deepEqual(one('save "The Midnight Inn"'), { op: "save", name: "The Midnight Inn", withTokens: false });
  assert.deepEqual(one('save "The Midnight Inn" with tokens'), { op: "save", name: "The Midnight Inn", withTokens: true });
  assert.deepEqual(one("gen dungeon 10x10 rooms=3 doors=true seed=42"), {
    op: "gen",
    kind: "dungeon",
    size: { cols: 10, rows: 10 },
    opts: { rooms: "3", doors: "true", seed: "42" },
  });
});

test("bad input produces errors with hints", () => {
  const bad = (t) => parse(t)[0];
  assert.match(bad("4x3 wolf").hint, /4x3-wolf/);
  assert.match(bad("move player1 to 4x8").hint, /player1 > 4x8/);
  assert.match(bad("4,3-wall").hint, /RxC/);
  assert.match(bad("captoin hi").hint, /caption/);
  assert.match(bad("4x3->4x8").hint, /4x3 > 4x8/);
  assert.ok(bad("tok").error);
  assert.ok(bad("gen dungeon").error);
  assert.ok(bad("new").error);
  assert.equal(parse("").length, 0);
  assert.deepEqual(splitCommands(" , ;\n"), []);
});

test("props parser handles quotes and flags", () => {
  assert.deepEqual(parseProps('name="Old Snik" hp=7/7 blocking'), { props: { name: "Old Snik", hp: "7/7" }, flags: ["blocking"] });
});

test("command indexes are 1-based and stable", () => {
  const p = parse("1x1-wall, nonsense here, 2x2-wall");
  assert.deepEqual(p.map((x) => x.index), [1, 2, 3]);
  assert.ok(p[1].error);
});
