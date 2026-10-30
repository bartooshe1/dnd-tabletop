// The shipped Claude Code plugin: the committed esbuild bundle runs on its own (resources,
// page, tools), the bundled Stop hook works, commands pre-approve the tools, the installer is safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpDir } from "./helpers.mjs";
import { connectSse, post } from "./sse.mjs";
import { install, withAdditions, TOOLS, ENV_KEY } from "../scripts/install.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = path.join(ROOT, "plugin");

test("plugin layout follows the docs: manifest, .mcp.json, hooks, commands, marketplace", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "dnd-tabletop");
  const mcp = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.dnd.args, ["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"]);
  assert.ok(mcp.mcpServers.dnd.timeout >= 600000, "per-server timeout covers a 10-minute wait");
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, "hooks", "hooks.json"), "utf8"));
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/stop-hook\.mjs"$/);
  for (const f of ["startdnd.md", "continuednd.md"]) {
    const text = fs.readFileSync(path.join(PLUGIN, "commands", f), "utf8");
    const front = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
    assert.ok(front, `${f} has frontmatter`);
    for (const t of TOOLS) assert.ok(front[1].includes(t), `${f} pre-approves ${t}`);
    assert.match(front[1], /disable-model-invocation: true/);
    assert.ok(front[2].split(/\s+/).filter(Boolean).length <= 150, `${f} body <= 150 words`);
  }
  const market = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(market.plugins[0].name, manifest.name);
  assert.equal(market.plugins[0].source, "./plugin");
});

test("the committed bundle runs on its own: tools, resources, page, a turn", async () => {
  const dataDir = tmpDir();
  const client = new Client({ name: "bundle-test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(PLUGIN, "dist", "server.mjs")],
      cwd: tmpDir(),
      env: { ...process.env, DND_DATA_DIR: dataDir, DND_NO_BROWSER: "1", DND_PORT: "47990", DND_WAIT_MS: "5000" },
      stderr: "ignore",
    }),
  );
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["map", "notes", "roll", "turn"]);
  const started = await call("notes", { op: "new", text: "Bundle" });
  const url = new URL(/Page: (\S+)/.exec(started)[1]);
  assert.match(started, /## Claude Code mode/, "templates found next to the bundle");
  const html = await (await fetch(url)).text();
  assert.match(html, /<title>D&amp;D Tabletop<\/title>|<title>D&D Tabletop<\/title>/, "the real game page is served");
  assert.match(await call("map", { commands: 'new "T" 14x10, load tavern' }), /^ok/, "layouts found next to the bundle");
  const page = await connectSse(`${url.origin}/events`);
  const { token } = (await page.next("snapshot")).data;
  const turn = client.callTool({ name: "turn", arguments: { say: "Hello", map: "7x6-player" } });
  await page.next("state", (s) => s.waiting);
  await post(url.origin, "/api/say", { text: "hi DM" }, { token });
  assert.equal((await turn).content[0].text, "(map: player1 7x6)\nhi DM");
  page.close();
  await client.close();
});

test("the bundled Stop hook allows stops when no game runs and never fails the session", () => {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, "dist", "stop-hook.mjs")], {
    input: JSON.stringify({ session_id: "x", hook_event_name: "Stop", stop_hook_active: false }),
    env: { ...process.env, DND_DATA_DIR: tmpDir() },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const bad = spawnSync(process.execPath, [path.join(PLUGIN, "dist", "stop-hook.mjs")], { input: "not json", env: { ...process.env, DND_DATA_DIR: tmpDir() }, encoding: "utf8" });
  assert.equal(bad.status, 0, "garbage input still lets Claude stop");
});

test("installer: nothing without a yes; adds commands, allow rules and env idempotently with a backup", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "opus", permissions: { allow: ["Bash(git status)"] } }));
  const no = await install({ argv: ["node", "install", "--config-dir", dir], ask: async () => "", log: () => {} });
  assert.deepEqual(no, []);
  assert.equal(fs.existsSync(path.join(dir, "commands")), false);
  const yes = await install({ argv: ["node", "install", "--config-dir", dir], ask: async () => "y", log: () => {} });
  assert.ok(yes.includes("tool allow rules") && yes.includes(`${ENV_KEY}=0`));
  const s = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  assert.equal(s.model, "opus", "existing settings kept");
  assert.deepEqual(s.permissions.allow, ["Bash(git status)", ...TOOLS]);
  assert.equal(s.env[ENV_KEY], "0");
  assert.ok(fs.existsSync(path.join(dir, "commands", "startdnd.md")));
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("settings.json.bak-dnd-")), "backup written");
  // running again changes nothing
  assert.deepEqual(withAdditions(s, { permissions: true, env: true }), s);
  // dry run writes nothing
  const dry = tmpDir();
  await install({ argv: ["node", "install", "--config-dir", dry, "--yes", "--dry-run"], ask: async () => "y", log: () => {} });
  assert.deepEqual(fs.readdirSync(dry), []);
});

test("installer refuses to touch a settings.json it can't parse", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "settings.json"), "{ not json");
  await assert.rejects(install({ argv: ["node", "install", "--config-dir", dir], ask: async (q) => (q.startsWith("1)") ? "n" : "y"), log: () => {} }), /isn't valid JSON/);
  assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), "{ not json");
});
