// Claude Code mode end to end: the real server over stdio (MCP SDK client as "Claude"),
// a simulated page over HTTP/SSE, the Stop hook script, and the Desktop lock.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpDir } from "./helpers.mjs";
import { connectSse, post } from "./sse.mjs";
import { decide, REASON } from "../cc/stop-hook.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let client;
let dataDir;
let stderr = "";
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  return { ...r, text: r.content.map((c) => c.text).join("\n") };
};

function runHook(input, env = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "cc", "stop-hook-main.js")], {
    input: JSON.stringify(input),
    env: { ...process.env, DND_DATA_DIR: dataDir, ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

before(async () => {
  dataDir = tmpDir();
  client = new Client({ name: "claude-code-sim", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "cc", "index.js")],
    env: { ...process.env, DND_DATA_DIR: dataDir, DND_NO_BROWSER: "1", DND_PORT: "47960", DND_WAIT_MS: "1500", DND_IDLE_STOP: "2" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => (stderr += d));
  await client.connect(transport);
});
after(async () => client?.close());

test("exactly 4 tools in Claude Code mode, short instructions", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["map", "notes", "roll", "turn"]);
  assert.ok(client.getInstructions().split(/\s+/).length <= 110);
});

test("scripted game: new campaign, turns through the page, rolls, idle, idle-stop, resume, pause", async () => {
  const transcript = path.join(dataDir, "fake-transcript.jsonl");
  fs.writeFileSync(transcript, '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__plugin_dnd-tabletop_dnd__turn"}]}}\n');
  const hookInput = (extra = {}) => ({ session_id: "game-session", transcript_path: transcript, hook_event_name: "Stop", stop_hook_active: false, ...extra });

  assert.equal(runHook(hookInput()).out, "", "no game yet: the hook allows stopping");

  const started = await call("notes", { op: "new", text: "The Sunken Crown" });
  const url = /Page: (http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/.exec(started.text)?.[1];
  assert.ok(url, started.text);
  assert.match(started.text, /=== house rules ===[\s\S]*## Claude Code mode/);
  assert.match(started.text, /=== campaign\.md \(fresh template\) ===[\s\S]*## DM Secrets/);
  const origin = new URL(url).origin;
  const page = await connectSse(`${origin}/events`);
  const { token, state } = (await page.next("snapshot")).data;
  assert.equal(state.title, "The Sunken Crown");

  // a turn blocks until the page answers
  const t1 = call("turn", { say: "Rain on the road. **What do you do?**", map: 'new "Road" 10x6, 3x2-player, tok player1 name=Aria hp=11/11, 3x9-wolf, tok wolf1 hp=11/11' });
  await page.next("chat", (m) => m.who === "dm" && /Rain on the road/.test(m.text));
  await page.next("map", (m) => m.tokens.length === 2);
  await page.next("state", (s) => s.waiting);
  // the Stop hook blocks while the game runs in this session...
  const blocked = runHook(hookInput());
  assert.deepEqual(JSON.parse(blocked.out), { decision: "block", reason: REASON });
  // ...but never loops: already continuing and no turn since the block -> allow
  assert.equal(runHook(hookInput({ stop_hook_active: true })).out, "");
  // ...and ignores other sessions once it knows the game's session
  assert.equal(runHook(hookInput({ session_id: "my-coding-session" })).out, "");
  await post(origin, "/api/roll", { dice: "d20" }, { token });
  await post(origin, "/api/say", { text: "I move to 3x4 and ready my bow" }, { token });
  const r1 = await t1;
  assert.match(r1.text, /^\(map: player1 3x2; wolf1 3x9\)\nI move to 3x4 and ready my bow \[rolled 1d20: \d+\]$/);

  // Claude's rolls show on the page; secret ones never do
  const before = page.events.length;
  const atk = await call("roll", { dice: "1d20+5 atk", roller: "Aria" });
  assert.match(atk.text, /^atk 1d20\+5: \[\d+\]\+5 = \d+/);
  await page.next("roll", (e) => e.roller === "Aria", { from: before });
  const secret = await call("roll", { dice: "1d20 morale", secret: true });
  assert.match(secret.text, /^secret: morale/);
  const mid = page.events.length;
  await call("map", { commands: "player1 > 3x4, tok wolf1 hp=-8" });
  await page.next("map", (m) => m.tokens.find((t) => t.id === "player1").c === 3, { from: mid });
  assert.ok(!page.events.slice(before).some((e) => JSON.stringify(e.data).includes("morale")), "no secret roll on the page");
  assert.ok(!JSON.stringify(page.events).match(/"hp":3,"maxHp":11|3\/11/), "no wolf HP numbers on the page");

  // map errors come back at once, narration still shown
  const t0 = Date.now();
  const bad = await call("turn", { say: "The wolf circles.", map: "3x4 > 99x99" });
  assert.equal(bad.isError, true);
  assert.ok(Date.now() - t0 < 1000, "no waiting on map errors");
  await page.next("chat", (m) => m.text === "The wolf circles.");

  // nobody answers: [idle], then [idle-stop]
  assert.equal((await call("turn", { say: "The wolf growls." })).text, "[idle]");
  assert.equal((await call("turn", {})).text, "[idle-stop]");
  await page.next("chat", (m) => m.who === "system" && /DM paused/.test(m.text));
  assert.equal(runHook(hookInput()).out, "", "idle-stopped: the hook lets Claude stop");

  // /continuednd: one result with rules, notes, recent log lines, current scene
  const resumed = await call("notes", { op: "resume" });
  assert.match(resumed.text, /=== house rules ===/);
  assert.match(resumed.text, /=== campaign\.md ===/);
  assert.match(resumed.text, /=== last \d+ session log lines ===[\s\S]*player1 moved 3x2→3x4/);
  assert.match(resumed.text, /=== current scene: Road 10x6 ===\ntokens: player1 'Aria' 3x4 11\/11; wolf1 3x9 3\/11/);
  const logPart = resumed.text.split("=== last")[1].split("=== current scene")[0];
  assert.doesNotMatch(logPart, /3\/11|morale/, "logs carry no enemy HP numbers or secret rolls");

  // Save & pause
  const t2 = call("turn", { say: "Night falls." });
  await page.next("state", (s) => s.waiting);
  await post(origin, "/api/pause", {}, { token });
  assert.equal((await t2).text, "[pause]");
  await call("notes", { op: "write", sections: { "Current State": "Camped on the road.", "Story Log": "Met a wolf.", "DM Secrets": "The wolf is a werewolf." } });
  assert.match((await call("notes", { op: "pause" })).text, /paused and saved/);
  await page.next("state", (s) => s.status === "paused");
  assert.equal(runHook(hookInput()).out, "", "paused: the hook allows stopping");
  assert.ok(!JSON.stringify(page.events).includes("werewolf"), "DM Secrets never reach the page");
  const logs = fs.readdirSync(path.join(dataDir, "sessions")).map((f) => fs.readFileSync(path.join(dataDir, "sessions", f), "utf8")).join("\n");
  assert.doesNotMatch(logs, /werewolf|morale|3\/11/);
  page.close();
});

test("the Desktop extension is locked out while Claude Code mode runs the campaign", async () => {
  await call("notes", { op: "resume" });
  const desktop = new Client({ name: "desktop-sim", version: "0" });
  await desktop.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "server", "index.js")], env: { ...process.env, DND_DATA_DIR: dataDir }, stderr: "ignore" }));
  const r = await desktop.callTool({ name: "map", arguments: { commands: "1x1-wall" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /open in Claude Code/);
  await call("notes", { op: "pause" });
  const ok = await desktop.callTool({ name: "show_map", arguments: {} });
  assert.notEqual(ok.isError, true, "free again after pause");
  await desktop.close();
});

test("Stop hook decision table", () => {
  const alive = () => true;
  const uses = () => true;
  const base = { active: true, paused: false, idleStop: false, pid: 1, lastTurnAt: 10, lastBlockAt: 5, ownerSession: "s" };
  assert.equal(decide({ session_id: "s" }, null).block, false);
  assert.equal(decide({ session_id: "s" }, { ...base, active: false }, { alive }).block, false);
  assert.equal(decide({ session_id: "s" }, { ...base, paused: true }, { alive }).block, false);
  assert.equal(decide({ session_id: "s" }, { ...base, idleStop: true }, { alive }).block, false);
  assert.equal(decide({ session_id: "s" }, base, { alive: () => false }).block, false);
  assert.equal(decide({ session_id: "other" }, base, { alive }).block, false);
  assert.equal(decide({ session_id: "s" }, base, { alive }).block, true);
  assert.equal(decide({ session_id: "s", stop_hook_active: true }, base, { alive }).block, true, "progress since the last block");
  assert.equal(decide({ session_id: "s", stop_hook_active: true }, { ...base, lastTurnAt: 4 }, { alive }).block, false, "loop guard");
  const unbound = { ...base, ownerSession: null };
  assert.equal(decide({ session_id: "x", transcript_path: "t" }, unbound, { alive, usesTurn: () => false }).block, false, "a session that never called turn");
  const d = decide({ session_id: "x", transcript_path: "t" }, unbound, { alive, usesTurn: uses, now: 99 });
  assert.deepEqual(d.patch, { lastBlockAt: 99, ownerSession: "x" });
});

test("server stderr has the page line; stdout stayed clean (the SDK would have failed otherwise)", () => {
  assert.match(stderr, /\[dnd-tabletop\] page at http:\/\/127\.0\.0\.1:47960\/\?t=/);
});

test("notes writes push the character sheet to the page", async () => {
  await call("notes", { op: "resume" });
  const url = /Page: (http:\/\/127\.0\.0\.1:\d+)/.exec((await call("notes", { op: "resume" })).text)[1];
  const page = await connectSse(`${url}/events`);
  await page.next("snapshot");
  await call("notes", { op: "write", sections: { Inventory: "- 40 gp\n- Rope (15 m)", "DM Secrets": "Hidden vault under the inn." } });
  const ev = await page.next("sheet", (s) => s.sections.some((x) => /40 gp/.test(x.body)));
  assert.doesNotMatch(JSON.stringify(ev.data), /vault/);
  await call("notes", { op: "pause" });
  page.close();
});
