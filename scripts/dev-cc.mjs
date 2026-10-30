// DEV ONLY: run the Claude Code mode server with a scripted stand-in DM, so the game page can be
// opened and clicked through without Claude. Talks to the real tools over an in-memory MCP link.
// Usage: node scripts/dev-cc.mjs [dataDir]   then open http://localhost:47800/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCcServer } from "../cc/server.js";
import { loadCcConfig } from "../cc/config.js";

const dataDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "dnd-dev-cc-"));
const config = loadCcConfig({ ...process.env, DND_DATA_DIR: dataDir, DND_NO_BROWSER: "1", DND_PORT: process.env.DND_PORT || "47800", DND_WAIT_MS: "600000", DND_LAN_BIND: process.env.DND_LAN_BIND || "127.0.0.1" });
const { server, page, startPage } = createCcServer(config, { browser: () => {} });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const dm = new Client({ name: "stand-in-dm", version: "0" });
await dm.connect(b);
await startPage();
const call = async (name, args) => (await dm.callTool({ name, arguments: args }, undefined, { timeout: 3_600_000 })).content.map((c) => c.text).join("\n");
process.stdout.write(`dev page: http://localhost:${page.port}/  (data: ${dataDir})\n`);

await call("notes", { op: "new", text: "The Sunken Crown" });
await call("notes", {
  op: "write",
  sections: {
    Character:
      `**Aria Thistlefoot** · Halfling Rogue 3 (Thief) · Criminal
**XP** 2,750 / 2,700 · **Level** 3
**AC** 14 · **Speed** 7.5 m · **Initiative** +3 · **Prof** +2
**STR** 8 (−1) · **DEX** 17 (+3) · **CON** 12 (+1)
**INT** 13 (+1) · **WIS** 10 (+0) · **CHA** 14 (+2)
Saves: DEX +5, INT +3
Skills: Stealth +7, Sleight of Hand +5, Perception +2, Acrobatics +5
Passive Perception 12 · Languages: Common, Halfling, Thieves' Cant
**Attacks**
- Shortsword: +5 to hit, 1d6+3 piercing
- Shortbow: +5 to hit, 1d6+3 piercing, 24/96 m
**Features**
- Sneak Attack 2d6 (once per turn)
- Cunning Action: Dash, Disengage or Hide as a bonus action
- Fast Hands, Lucky, Naturally Stealthy
**Hit dice** 3/3 d8`,
    Inventory: `**Money** 14 gp, 8 sp
- Shortsword, shortbow, 18 arrows
- Leather armor
- Thieves' tools
- Rope (15 m), 2 torches, rations (3 days)
- Potion of healing`,
    Quests: `- **The Sunken Crown**: find the crown lost when the old chapel sank. (open)
- Get out of the crypt alive. (open)`,
    NPCs: `- **Maud Tarn**: ferrywoman who brought you to the island. Gruff, honest, wants half the crown.
- **The Drowned Priest**: a voice you heard in a dream. Unknown.`,
    "World Notes": `- **Saltmere**: fishing town on the lake shore; the chapel sank there 40 years ago.
- The crypt floods at high tide.`,
    "Story Log": `- Hired Maud Tarn to row out to the sunken chapel.
- The floor gave way; you fell into the crypt below.`,
    "DM Secrets": "Maud Tarn is the priest's daughter (dev script: must never show on the page).",
  },
});
const gen = await call("map", { commands: 'new "Sunken Crypt" 20x14, gen dungeon 20x14 rooms=4 seed=42, caption Water drips from the ceiling.' });
const centers = [...gen.matchAll(/center (\d+x\d+)/g)].map((m) => m[1]);
await call("map", { commands: `${centers[0]}-player, tok player1 name=Aria hp=17/23 status=poisoned,concentrating, ${centers[2]}-skeleton, tok skeleton1 hp=6/13, ${centers[1]}-giant_rat, tok giant_rat1 hp=1/7 status=prone` });
const [pr, pc] = centers[3].split("x").map(Number);
await call("map", { commands: `${pr - 1}x${pc - 1}..${pr + 1}x${pc + 1}-water, ${pr}x${pc}-deep_water, ${centers[0].split("x")[0]}x${Number(centers[0].split("x")[1]) + 1}-fire, init player1=15 skeleton1=12 giant_rat1=8` });
let said = await call("turn", {
  say: "You wake on cold stone. **Water drips** somewhere in the dark, and something *scrapes* beyond the far door.\n\n- Your pack is still on your back.\n- Your torch is nearly out.\n\nWhat do you do?",
});
for (;;) {
  const cell = /(\d+x\d+)/.exec(said)?.[1];
  if (said === "[pause]") {
    await call("notes", { op: "write", sections: { "Current State": "Paused in the crypt (dev script)." } });
    await call("notes", { op: "pause" });
    said = await call("turn", { say: "Paused. (dev script)", wait: true });
    continue;
  }
  if (/^(next|end turn|done)$/i.test(said)) {
    await call("map", { commands: "init next" });
    said = await call("turn", { say: "The turn passes. What do you do?" });
  } else if (/attack|hit|strike/i.test(said)) {
    await call("roll", { dice: "1d20+5 atk, 1d8+3 dmg", roller: "Aria", label: "Shortsword vs skeleton: second strike after Maud Tarn distracts it (advantage lost, DC hidden)" });
    await call("map", { commands: "tok skeleton1 hp=-7" });
    said = await call("turn", { say: "Your blade bites into old bone. The skeleton **staggers**. What do you do?" });
  } else if (cell) {
    const r = await call("map", { commands: `player1 > ${cell}` }).catch((e) => e.message);
    said = await call("turn", { say: /nothing applied/.test(r) ? `You can't go to ${cell}: ${r.split("\n")[1] ?? r}` : `You move to ${cell}. The scraping stops. What do you do?` });
  } else said = await call("turn", { say: `*(stand-in DM)* You said: "${said}". What do you do?` });
}
