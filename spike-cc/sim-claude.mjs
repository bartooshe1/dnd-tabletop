// Stands in for Claude: drives the spike server's `turn` tool over stdio the way /startdnd tells
// Claude to, so the loop can be checked without an account. Pair with drive.mjs (the page side).
// Usage: node spike-cc/sim-claude.mjs <dataDir>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const dataDir = process.argv[2];
const t0 = Date.now();
const log = (m) => console.log(`[claude +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const client = new Client({ name: "sim-claude", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
    env: { ...process.env, DND_DATA_DIR: dataDir },
    stderr: "inherit",
  }),
);
const turn = async (args) => {
  const t = Date.now();
  const r = await client.callTool({ name: "turn", arguments: args }, undefined, { timeout: 3600000 });
  const text = r.content[0].text;
  log(`turn(${JSON.stringify(args).slice(0, 70)}) waited ${((Date.now() - t) / 1000).toFixed(1)}s -> ${JSON.stringify(text)}`);
  return text;
};
let said = await turn({ say: "Welcome to the spike.", map: 'new "Spike" 10x8, load small_chamber at 1x2, 4x5-player' });
for (let i = 0; i < 12; i++) {
  if (said === "[idle]") said = await turn({});
  else if (said === "[pause]" || said === "[idle-stop]") {
    await turn({ wait: false, say: "Paused. Bye!" });
    break;
  } else {
    const cell = /(\d+x\d+)/.exec(said)?.[1];
    said = await turn({ say: `You said: ${said}`, ...(cell ? { map: `player1 > ${cell}` } : {}) });
  }
}
await client.close();
log("done");
