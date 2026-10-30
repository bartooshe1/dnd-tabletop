// Spawns the real server over stdio and drives all 4 tools through the MCP SDK client.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpDir } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = path.join(ROOT, "server", "index.js");
const MIME = "text/html;profile=mcp-app";
const KEY = "dnd-tabletop/view";

async function connect({ ui, env = {} }) {
  const dataDir = tmpDir();
  const capabilities = ui ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MIME] } } } : {};
  const client = new Client({ name: "itest", version: "0" }, { capabilities });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { ...process.env, DND_DATA_DIR: dataDir, ...env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { ...res, text: res.content.map((c) => c.text).join("\n") };
  };
  return { client, call, dataDir, stderr: () => stderr };
}

let ui;
let plain;
before(async () => {
  ui = await connect({ ui: true });
  plain = await connect({ ui: false });
});
after(async () => {
  await ui.client.close();
  await plain.client.close();
});

test("exactly 4 tools; UI metadata on show_map and roll (new and legacy keys)", async () => {
  const { tools } = await ui.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["map", "notes", "roll", "show_map"]);
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(by.show_map._meta.ui.resourceUri, "ui://dnd/map");
  assert.equal(by.show_map._meta["ui/resourceUri"], "ui://dnd/map");
  assert.equal(by.roll._meta.ui.resourceUri, "ui://dnd/dice");
  assert.equal(by.map._meta, undefined, "map edits are silent");
  assert.equal(by.notes._meta, undefined);
});

test("server instructions are present and short", async () => {
  const instr = ui.client.getInstructions();
  assert.ok(instr.length > 50);
  assert.ok(instr.split(/\s+/).length <= 100, `instructions are ${instr.split(/\s+/).length} words`);
});

test("ui:// resources are readable with the MCP Apps MIME type and are self-contained", async () => {
  for (const uri of ["ui://dnd/map", "ui://dnd/dice"]) {
    const r = await ui.client.readResource({ uri });
    const c = r.contents[0];
    assert.equal(c.uri, uri);
    assert.equal(c.mimeType, MIME);
    assert.match(c.text, /^<!DOCTYPE html>/i);
    assert.doesNotMatch(c.text, /<script[^>]+src=|<link[^>]+href=["']https?:/i, "no external scripts or styles");
    assert.ok(c.text.length > 5000, "UI bundle is inlined");
    assert.equal(c._meta.ui.prefersBorder, false);
  }
  const { resources } = await ui.client.listResources();
  assert.deepEqual(resources.map((r) => r.uri).sort(), ["ui://dnd/dice", "ui://dnd/map"]);
});

test("map + show_map with UI: tiny results, card data only in _meta", async () => {
  const r1 = await ui.call("map", { commands: 'new "Crypt" 12x10, load crypt, 9x6-player, tok player1 hp=12/20, 2x3-skeleton, tok skeleton1 hp=3/13' });
  assert.equal(r1.isError, undefined);
  assert.equal(r1.text, "ok; player1 9x6; skeleton1 2x3");
  assert.equal(r1._meta, undefined);
  const r2 = await ui.call("show_map");
  assert.equal(r2.text, "shown: Crypt 12x10, 1 sq = 1.5 m");
  const view = r2._meta[KEY];
  assert.equal(view.name, "Crypt");
  assert.equal(view.tokens.find((t) => t.id === "player1").hp, 12);
  const sk = view.tokens.find((t) => t.id === "skeleton1");
  assert.equal(sk.wound, "badly wounded");
  assert.equal(sk.hp, undefined);
  assert.equal(r2.structuredContent, undefined, "nothing for the UI goes where the model might read it");
  const r3 = await ui.call("show_map", { tokens: true });
  assert.match(r3.text, /tokens: player1 9x6 12\/20; skeleton1 2x3 3\/13/);
});

test("map errors: nothing applied, every error listed, isError set", async () => {
  const r = await ui.call("map", { commands: "1x1-wall, 99x1-wall, 2x2 > 3x3" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^nothing applied:\n#2 .*off the map.*\n#3 .*no token at 2x2/);
  const shown = await ui.call("show_map");
  assert.equal(shown._meta[KEY].terrain[0][0], shown._meta[KEY].palette.findIndex((p) => p.id === "wall"), "1x1 is still the crypt wall");
});

test("show_map without MCP Apps returns a full text fallback", async () => {
  await plain.call("map", { commands: 'new "Hall" 6x4, 1x1..1x6-wall, 3x2-player, 3x5-wolf, tok wolf1 hp=2/11' });
  const r = await plain.call("show_map");
  assert.match(r.text, /^Hall 6x4 \(W×H\), 1 sq = 1.5 m/);
  assert.match(r.text, /\n {2}1 ######\n/);
  assert.match(r.text, /wolf1 3x5 near death/);
  assert.doesNotMatch(r.text, /2\/11/);
});

test("roll: text result, dice card data, history; secret rolls hide everything", async () => {
  const r = await ui.call("roll", { dice: "1d20+5 atk, 1d8+3 dmg", roller: "Aria" });
  assert.match(r.text, /^atk 1d20\+5: \[\d+\]\+5 = \d+( NAT (20|1))?\ndmg 1d8\+3: \[\d\]\+3 = \d+$/);
  const view = r._meta[KEY];
  assert.equal(view.kind, "dice");
  assert.equal(view.rolls.length, 2);
  assert.equal(view.roller, "Aria");
  const atk = view.rolls[0];
  assert.equal(atk.total, atk.groups[0].rolls[0] + 5, "card total equals the server's value");
  const adv = await ui.call("roll", { dice: "1d20", mode: "adv", label: "Stealth" });
  assert.match(adv.text, /^Stealth 1d20 \(adv\): \[\d+\|\d+\] = \d+/);
  const secret = await ui.call("roll", { dice: "1d20+2", secret: true, label: "goblin morale" });
  assert.match(secret.text, /^secret: goblin morale 1d20\+2: /);
  assert.deepEqual(secret._meta[KEY], { v: 1, kind: "dice", secret: true }, "no numbers reach the card");
  const next = await ui.call("roll", { dice: "1d4" });
  const history = next._meta[KEY].history;
  assert.ok(history.length >= 2);
  assert.ok(history.every((h) => !h.text.join(" ").includes("goblin morale")), "secret rolls are not in the visible history");
  const bad = await ui.call("roll", { dice: "1d7" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /d7 isn't a die/);
});

test("notes: read Current State by default, write/append, rules", async () => {
  const r0 = await ui.call("notes");
  assert.match(r0.text, /^## Current State\n/);
  assert.equal((await ui.call("notes", { op: "write", section: "Current State", text: "In the crypt." })).text, "ok");
  assert.equal((await ui.call("notes", { op: "append", section: "Inventory", text: "- torch" })).text, "ok");
  assert.equal((await ui.call("notes")).text, "## Current State\nIn the crypt.");
  assert.match((await ui.call("notes", { section: "all" })).text, /- torch/);
  assert.match((await ui.call("notes", { file: "rules" })).text, /# House Rules/);
  const bad = await ui.call("notes", { op: "write", text: "x" });
  assert.equal(bad.isError, true);
});

test("saved rooms land in the data folder and in campaign.md", async () => {
  await ui.call("map", { commands: 'new "Inn" 8x6, 2x2-bar, save "The Midnight Inn"' });
  assert.ok(fs.existsSync(path.join(ui.dataDir, "rooms", "the_midnight_inn.json")));
  assert.match(fs.readFileSync(path.join(ui.dataDir, "campaign.md"), "utf8"), /## Saved rooms[\s\S]*- The Midnight Inn/);
  const r = await ui.call("map", { commands: "rooms" });
  assert.match(r.text, /saved: the_midnight_inn 8x6/);
});

test("state persists across server restarts", async () => {
  const a = await connect({ ui: true });
  await a.call("map", { commands: 'new "Keep" 7x7, 4x4-player' });
  await a.client.close();
  const b = await connect({ ui: true, env: { DND_DATA_DIR: a.dataDir } });
  const r = await b.call("show_map", { tokens: true });
  assert.match(r.text, /shown: Keep 7x7/);
  assert.match(r.text, /player1 4x4/);
  await b.client.close();
});

test("imperial units and detailed results come from env (manifest user_config)", async () => {
  const s = await connect({ ui: true, env: { DND_UNITS: "imperial", DND_DETAIL: "detailed" } });
  const r = await s.call("map", { commands: 'new "A" 8x8, 1x1-player, player1 > 1x5' });
  assert.match(r.text, /player1 1x1→1x5 20 ft/);
  assert.match((await s.call("show_map")).text, /1 sq = 5 ft/);
  await s.client.close();
});

test("nothing but JSON-RPC on stdout (logs go to stderr)", async () => {
  // the SDK client would have failed to parse any stray stdout line; check stderr got our log line
  assert.match(ui.stderr(), /\[dnd-tabletop\] ready/);
});
