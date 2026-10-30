// Approximate token sizes (chars / 4) of what this project puts in Claude's context, for both
// front ends: the tool list + server instructions (every turn) and typical tool results.
// Usage: node scripts/measure-tokens.mjs [--json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const BUDGET = 1200; // tool list + instructions, in approx tokens, per tool set
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tok = (s) => Math.ceil(String(s).length / 4);

const BATCH20 = [
  'new "Crypt" 16x12',
  "load crypt at 1x2",
  "caption Cold air and old dust",
  "9x6-player",
  "tok player1 name=Aria hp=17/23",
  "2x3-skeleton",
  "2x6-skeleton",
  "4x9-skeleton",
  "tok skeleton1 hp=13/13",
  "tok skeleton2 hp=13/13",
  "tok skeleton3 hp=13/13 status=prone",
  "6x2..6x3-rubble",
  "8x12-chest",
  "5x5-trap",
  "player1 > 8x6",
  "skeleton1 > 3x4",
  "skeleton2 > 3x7",
  "tok skeleton2 hp=-5",
  "7x7-fire",
  "scale 1.5",
].join(", ");

async function connect(entry, env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dnd-measure-"));
  const client = new Client(
    { name: "measure", version: "0" },
    { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } },
  );
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, entry)], env: { ...process.env, DND_DATA_DIR: dataDir, ...env }, stderr: "ignore" }),
  );
  // What the model sees per tool: name, description, input schema (+ annotations).
  const { tools } = await client.listTools();
  const modelView = tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, input_schema: inputSchema, annotations }));
  const instructions = client.getInstructions() ?? "";
  // Only `content` enters model context; _meta (card data) is UI-only.
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content.map((c) => c.text).join("\n");
  const close = async () => {
    await client.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  const fixed = {
    perTool: Object.fromEntries(modelView.map((t) => [t.name, tok(JSON.stringify(t))])),
    toolsTokens: tok(JSON.stringify(modelView)),
    instrTokens: tok(instructions),
    instrWords: instructions.split(/\s+/).filter(Boolean).length,
  };
  fixed.fixedTokens = fixed.toolsTokens + fixed.instrTokens;
  return { call, close, fixed, dataDir };
}

const summarize = (results) => Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { tokens: tok(v), text: v }]));

async function measureDesktop() {
  const { call, close, fixed } = await connect("server/index.js", {});
  const r = {};
  r["map: 20-command batch"] = await call("map", { commands: BATCH20 });
  r["map: error batch (3 errors)"] = await call("map", { commands: "1x1-wetfloor, 30x30-wall, 9x9 > 1x1" });
  r["show_map (card)"] = await call("show_map", {});
  r["show_map tokens:true (get state)"] = await call("show_map", { tokens: true });
  r["map: gen dungeon 20x14 rooms=4"] = await call("map", { commands: 'new "Deep" 20x14, gen dungeon 20x14 rooms=4 seed=42' });
  r["roll: attack + damage"] = await call("roll", { dice: "1d20+5 atk, 1d8+3 dmg", roller: "Aria" });
  r["roll: secret"] = await call("roll", { dice: "1d20+2", secret: true, label: "morale" });
  r["notes read (Current State)"] = await call("notes", {});
  r["notes read section=all (fresh file)"] = await call("notes", { section: "all" });
  r["notes read file=rules"] = await call("notes", { file: "rules" });
  r["notes append"] = await call("notes", { op: "append", section: "Story Log", text: "Cleared the crypt." });
  await close();
  return { ...fixed, results: summarize(r) };
}

async function measureCc() {
  const { call, close, fixed, dataDir } = await connect("cc/index.js", { DND_NO_BROWSER: "1", DND_PORT: "47870", DND_WAIT_MS: "1000", DND_IDLE_STOP: "99" });
  const r = {};
  r["notes op=new (rules + template + link)"] = await call("notes", { op: "new", text: "Measure" });
  const port = /127\.0\.0\.1:(\d+)/.exec(r["notes op=new (rules + template + link)"])[1];
  const origin = `http://127.0.0.1:${port}`;
  // a page that answers each turn
  const es = await fetch(`${origin}/events`);
  const reader = es.body.getReader();
  let buf = "";
  while (!buf.includes("\n\n")) buf += new TextDecoder().decode((await reader.read()).value);
  const token = JSON.parse(/^data: (.+)$/m.exec(buf)[1]).token;
  const answer = (text) => setTimeout(() => fetch(`${origin}/api/say`, { method: "POST", headers: { "content-type": "application/json", "x-dnd-token": token, origin }, body: JSON.stringify({ text }) }), 150);
  answer("I search the room");
  r["turn: narration + 20-command map, player reply"] = await call("turn", { say: "You enter the crypt. What do you do?", map: BATCH20 });
  answer("I attack the skeleton");
  r["turn: narration only, player reply"] = await call("turn", { say: "The skeleton turns toward you." });
  r["turn: [idle] (no reply)"] = await call("turn", {});
  r["map: gen dungeon 20x14 rooms=4"] = await call("map", { commands: 'new "Deep" 20x14, gen dungeon 20x14 rooms=4 seed=42' });
  r["roll: attack + damage"] = await call("roll", { dice: "1d20+5 atk, 1d8+3 dmg", roller: "Aria" });
  r["notes: batched end-of-scene write"] = await call("notes", {
    op: "write",
    sections: { "Current State": "In the crypt.", "Story Log": "Fought skeletons.", NPCs: "-", Quests: "Find the crown.", "World Notes": "-", "DM Secrets": "The crown is cursed.", Character: "Aria, rogue 3, HP 17/23" },
  });
  r["notes op=pause"] = await call("notes", { op: "pause" });
  r["notes op=resume (rules + notes + log + scene)"] = await call("notes", { op: "resume" });
  reader.cancel();
  await close();
  void dataDir;
  return { ...fixed, results: summarize(r) };
}

export async function measure() {
  return { desktop: await measureDesktop(), cc: await measureCc() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = await measure();
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(m, null, 2) + "\n");
  } else {
    const line = (k, v) => process.stdout.write(`${k.padEnd(48)} ${String(v).padStart(6)}\n`);
    for (const [title, set] of [["Claude Desktop extension", m.desktop], ["Claude Code mode", m.cc]]) {
      process.stdout.write(`\n== ${title} (approx tokens, chars/4) ==\nEvery turn:\n`);
      for (const [k, v] of Object.entries(set.perTool)) line(`  tool ${k}`, v);
      line("  tool list total", set.toolsTokens);
      line(`  server instructions (${set.instrWords} words)`, set.instrTokens);
      line("  fixed per-turn total", set.fixedTokens);
      line("  budget", BUDGET);
      process.stdout.write("Typical results:\n");
      for (const [k, v] of Object.entries(set.results)) line(`  ${k}`, v.tokens);
    }
  }
  const over = Object.entries(m).filter(([, s]) => s.fixedTokens > BUDGET);
  if (over.length) {
    process.stderr.write(`\nOVER BUDGET: ${over.map(([k, s]) => `${k} ${s.fixedTokens}`).join(", ")} > ${BUDGET}\n`);
    process.exit(1);
  }
}
