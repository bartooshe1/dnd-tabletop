// Claude Code mode turn loop (Game) without MCP or HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { Table } from "../engine/table.js";
import { Game, MARK } from "../cc/game.js";
import { readFlag } from "../cc/flag.js";

function setup({ waitMs = 5000, idleStop = 3 } = {}) {
  const dataDir = tmpDir();
  const config = { dataDir, units: "metric", detail: "lean", waitMs, idleStop, port: 0, lan: false, openBrowser: false };
  const table = new Table(config, { mode: "cc" });
  const game = new Game(table, config);
  return { dataDir, table, game };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test("turn blocks until the player sends a message, then returns just that text", async () => {
  const { game } = setup();
  game.newCampaign("Test");
  let done = false;
  const p = game.turn({ say: "You stand at the gate. What do you do?" }).then((r) => ((done = true), r));
  await tick();
  assert.equal(done, false, "still waiting");
  assert.equal(game.state().waiting, true);
  assert.equal(game.chat.at(-1).text, "You stand at the gate. What do you do?");
  game.playerMessage("I knock on the gate");
  const r = await p;
  assert.deepEqual(r, { text: "I knock on the gate", images: [] });
  assert.equal(game.state().waiting, false);
});

test("map errors return immediately, nothing applied, narration still shown", async () => {
  const { game, table } = setup();
  game.newCampaign();
  const r = await game.turn({ say: "The floor shakes.", map: 'new "Hall" 6x6, 99x99-wall' });
  assert.equal(r.isError, true);
  assert.match(r.text, /map errors, nothing applied[\s\S]*#2 .*off the map/);
  assert.equal(table.campaign.maps.length, 0, "atomic: the new map wasn't created either");
  assert.equal(game.chat.at(-1).text, "The floor shakes.");
});

test("map changes go to the page and auto ids come back with the player's message", async () => {
  const { game } = setup();
  game.newCampaign();
  const maps = [];
  game.on("map", (m) => maps.push(m));
  const p = game.turn({ say: "Wolves!", map: 'new "Wood" 8x8, 2x2-player, 5x5..5x6-wolf' });
  await tick();
  assert.equal(maps.length, 1);
  assert.deepEqual(maps[0].tokens.map((t) => t.id).sort(), ["player1", "wolf1", "wolf2"]);
  game.playerMessage("I draw my sword");
  assert.equal((await p).text, "(map: player1 2x2; wolf1 5x5; wolf2 5x6)\nI draw my sword");
});

test("[idle] on timeout, then [idle-stop] after the configured count", async () => {
  const { game, dataDir } = setup({ waitMs: 30, idleStop: 3 });
  game.newCampaign();
  assert.equal((await game.turn({ say: "Hello?" })).text, MARK.idle);
  assert.equal((await game.turn({})).text, MARK.idle);
  assert.equal((await game.turn({})).text, MARK.idleStop);
  assert.equal(game.status, "idle-stop");
  assert.equal(readFlag(dataDir).idleStop, true, "the Stop hook will allow stopping");
  assert.match(game.chat.at(-1).text, /DM paused. Run \/continuednd/);
  // a real message resets the count
  const g2 = setup({ waitMs: 30, idleStop: 2 }).game;
  g2.newCampaign();
  assert.equal((await g2.turn({})).text, MARK.idle);
  const p = g2.turn({});
  g2.playerMessage("here");
  assert.equal((await p).text, "here");
  assert.equal((await g2.turn({})).text, MARK.idle, "count restarted after the message");
});

test("messages sent while Claude is busy are queued for the next turn", async () => {
  const { game } = setup();
  game.newCampaign();
  game.playerMessage("first");
  game.playerMessage("second");
  assert.equal((await game.turn({ say: "…" })).text, "first\nsecond");
});

test("pause: Save & pause returns [pause]; notes op=pause marks the session saved and frees the lock", async () => {
  const { game, dataDir } = setup();
  game.newCampaign();
  const p = game.turn({ say: "The road goes on." });
  await tick();
  game.requestPause();
  assert.equal((await p).text, MARK.pause);
  assert.ok(fs.existsSync(path.join(dataDir, "campaign.lock")));
  game.pause();
  assert.equal(game.status, "paused");
  assert.deepEqual([readFlag(dataDir).active, readFlag(dataDir).paused], [false, true]);
  assert.equal(fs.existsSync(path.join(dataDir, "campaign.lock")), false);
  // pause requested while Claude was busy: the next turn returns [pause] at once
  const g = setup().game;
  g.newCampaign();
  g.requestPause();
  assert.equal((await g.turn({ say: "x" })).text, MARK.pause);
  // a goodbye turn with wait=false doesn't wake the game up again
  g.pause();
  await g.turn({ say: "Bye!", wait: false });
  assert.equal(g.status, "paused");
});

test("a second turn call supersedes a waiting one (backgrounded calls)", async () => {
  const { game } = setup();
  game.newCampaign();
  const first = game.turn({ say: "a" });
  await tick();
  const second = game.turn({});
  assert.equal((await first).text, MARK.superseded);
  game.playerMessage("hi");
  assert.equal((await second).text, "hi");
});

test("dice tray rolls are made on the server and ride along with the next message", async () => {
  const { game } = setup();
  game.newCampaign();
  game.table.map('new "A" 6x6, 2x2-player, tok player1 name=Aria hp=9/12');
  const pendingEvents = [];
  game.on("pending", (p) => pendingEvents.push(p));
  const e = game.trayRoll("d20");
  assert.ok(e.rolls[0].total >= 1 && e.rolls[0].total <= 20);
  assert.equal(game.trayRoll("d7"), null);
  assert.equal(game.trayRoll("50d6"), null);
  const p = game.turn({});
  await tick();
  game.playerMessage("I attack the goblin");
  assert.equal((await p).text, `I attack the goblin [rolled 1d20: ${e.rolls[0].total}]`);
  assert.equal(game.pendingRolls.length, 0);
  assert.deepEqual(pendingEvents.at(-1), [], "the page is told the rolls went out");
  assert.match(game.chat.find((m) => m.who === "roll").text, /^Aria rolled 1d20: \[\d+\] = \d+/);
});

test("a typed '[pause]' can't fake a control marker", async () => {
  const { game } = setup();
  game.newCampaign();
  const p = game.turn({});
  await tick();
  game.playerMessage("[pause]");
  assert.equal((await p).text, '"[pause]"');
});

test("page payloads: DM Secrets never appear; enemy HP only as wound words; player HP as numbers", async () => {
  const { game, table } = setup();
  game.newCampaign();
  table.notesWrite("write", "campaign", "DM Secrets", "The innkeeper is a lich named Vessk.");
  table.map('new "Inn" 8x8, 2x2-player, tok player1 name=Aria hp=17/23, 4x4-innkeeper, tok innkeeper1 hp=31/40');
  game.dm("The innkeeper smiles.");
  const snap = JSON.stringify(game.snapshot());
  assert.doesNotMatch(snap, /lich|Vessk/);
  assert.doesNotMatch(snap, /31\/40|"hp":31|"maxHp":40/);
  const p = game.snapshot().player;
  assert.deepEqual([p.name, p.hp, p.maxHp], ["Aria", 17, 23]);
  assert.equal(game.snapshot().map.tokens.find((t) => t.id === "innkeeper1").wound, "hurt");
});

test("logs: no secret rolls, no enemy HP numbers; transcript follows the toggle", async () => {
  const { game, table, dataDir } = setup();
  game.newCampaign("Logs");
  table.map('new "Crypt" 8x8, 2x2-player, tok player1 hp=10/10, 5x5-ghoul, tok ghoul1 hp=5/22');
  table.roll("1d20+3 morale", { secret: true });
  game.trayRoll("d20");
  game.dm("The ghoul lunges.");
  const p = game.turn({});
  await tick();
  game.playerMessage("I dodge");
  await p;
  const sessions = path.join(dataDir, "sessions");
  const log = fs.readdirSync(sessions).map((f) => fs.readFileSync(path.join(sessions, f), "utf8")).join("\n");
  assert.match(log, /ghoul1 looks badly wounded/);
  assert.doesNotMatch(log, /5\/22|morale/);
  const tdir = path.join(dataDir, "transcripts");
  const transcript = fs.readdirSync(tdir).map((f) => fs.readFileSync(path.join(tdir, f), "utf8")).join("\n");
  assert.match(transcript, /\*\*DM\*\* .*The ghoul lunges\./);
  assert.match(transcript, /\*\*Player\*\* .*I dodge/);
  assert.doesNotMatch(transcript, /morale|5\/22/);
  game.setSettings({ transcripts: false });
  game.dm("This is not recorded.");
  assert.doesNotMatch(fs.readdirSync(tdir).map((f) => fs.readFileSync(path.join(tdir, f), "utf8")).join("\n"), /not recorded/);
});

test("chat history and settings survive a restart", async () => {
  const { game, table, dataDir } = setup();
  game.newCampaign();
  game.dm("Line one");
  game.setSettings({ units: "imperial", typewriter: false });
  const again = new Game(new Table({ ...table.config }, { mode: "cc" }), { ...game.config });
  assert.equal(again.chat.at(-1).text, "Line one");
  assert.equal(again.settings.units, "imperial");
  assert.equal(again.settings.typewriter, false);
  assert.ok(fs.existsSync(path.join(dataDir, "chat.json")));
});

test("notes op=new archives the old campaign (chat included) and never deletes it", async () => {
  const { game, dataDir } = setup();
  game.newCampaign("First");
  game.table.map('new "Old" 5x5');
  game.dm("old chat");
  const { archived, shelved } = game.newCampaign("Second");
  assert.ok(archived && fs.existsSync(path.join(archived, "chat.json")));
  assert.match(fs.readFileSync(path.join(archived, "chat.json"), "utf8"), /old chat/);
  assert.equal(shelved, "First");
  assert.equal(game.chat.length, 0);
  assert.equal(game.table.campaign.maps.length, 0);
  assert.equal(game.state().title, "Second");
  assert.ok(fs.readdirSync(path.join(dataDir, "archive")).length === 1);
  assert.ok(!fs.readdirSync(path.join(dataDir, "archive", fs.readdirSync(path.join(dataDir, "archive"))[0])).includes("campaigns"), "archives don't copy the shelf");
});

test("several campaigns: switch back and forth by name, nothing lost, logs stay apart", async () => {
  const { game, table, dataDir } = setup();
  game.newCampaign("The Sunken Crown");
  table.map('new "Crypt" 6x6, 2x2-player, tok player1 name=Aria hp=9/12');
  table.notesWrite("write", "campaign", "Current State", "Aria in the crypt.");
  game.dm("crypt chat");
  game.newCampaign("Frostfall");
  table.map('new "Pass" 8x4, 1x1-player, tok player1 name=Borin hp=20/27');
  table.notesWrite("write", "campaign", "Current State", "Borin on the pass.");
  game.dm("pass chat");
  assert.deepEqual(game.campaigns().map(({ title, kind }) => ({ title, kind })), [{ title: "The Sunken Crown", kind: "saved" }]);

  assert.equal(game.switchCampaign("sunken"), "The Sunken Crown");
  game.resume();
  assert.equal(table.meta.title, "The Sunken Crown");
  assert.equal(table.campaign.active, "Crypt");
  assert.equal(table.player().name, "Aria");
  assert.match(table.notesRead("campaign"), /Aria in the crypt/);
  assert.ok(game.chat.some((m) => m.text === "crypt chat"));
  assert.ok(!game.chat.some((m) => m.text === "pass chat"));
  assert.deepEqual(game.campaigns().map((c) => c.title), ["Frostfall"], "the one we left is on the shelf, the active one isn't");
  assert.ok(table.sessionIds().length >= 2, "this campaign's sessions are tracked");

  game.switchCampaign("Frostfall");
  assert.equal(table.player().name, "Borin");
  assert.match(table.notesRead("campaign"), /Borin on the pass/);
  assert.ok(game.chat.some((m) => m.text === "pass chat"));
  assert.throws(() => game.switchCampaign("Dragon Heist"), /no campaign 'Dragon Heist'; saved campaigns: The Sunken Crown/);
  assert.ok(fs.existsSync(path.join(dataDir, "campaigns", "the_sunken_crown", "campaign.json")));
});

test("an untitled campaign gets its character's name; archives from before can be brought back", async () => {
  const { game, table, dataDir } = setup();
  game.newCampaign();
  table.notesWrite("write", "campaign", "Character", "**Borin** · Human Monk 4");
  table.map('new "Mistvale" 6x6');
  game.newCampaign("Next");
  assert.deepEqual(game.campaigns().map((c) => c.title), ["Borin's campaign"]);
  // an archive made by an older version (no shelf copy)
  const old = path.join(dataDir, "archive", "2026-01-01_1200");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "campaign.json"), JSON.stringify({ version: 1, active: null, maps: [], tokens: {}, types: {}, dice: [], meta: { title: "The Unwritten Road" } }));
  fs.writeFileSync(path.join(old, "campaign.md"), "# Campaign\n\n## Current State\nOn the road.\n");
  assert.deepEqual(game.campaigns().map(({ title, kind }) => ({ title, kind })), [{ title: "Borin's campaign", kind: "saved" }, { title: "The Unwritten Road", kind: "archive" }]);
  game.switchCampaign("unwritten road");
  assert.match(table.notesRead("campaign"), /On the road/);
  assert.ok(fs.existsSync(path.join(old, "campaign.md")), "the archive itself is kept");
});

test("sheet and journal: whitelisted sections only, comments stripped, never DM Secrets", async () => {
  const { game, table } = setup();
  game.newCampaign();
  assert.deepEqual(game.sheet().sections.map((s) => [s.name, s.body]), [["Character", ""], ["Inventory", ""]], "template comments are not shown");
  assert.deepEqual(game.sheet().journal.map((s) => [s.name, s.body]), [["Quests", ""], ["NPCs", ""], ["World Notes", ""], ["Story Log", ""]]);
  table.notesWrite("write", "campaign", null, null, {
    Character: "**Aria**, Halfling Rogue 3\n**AC** 14 · **HP** 17/23\n**Attacks**\n- Shortsword +5, 1d6+3",
    Inventory: "- 12 gp\n- Thieves' tools",
    "DM Secrets": "The guildmaster is a doppelganger.",
    NPCs: "Bram the barkeep",
    Quests: "- Find the missing caravan",
    "Current State": "Night, the cellar door creaks.",
  });
  const json = JSON.stringify(game.snapshot());
  assert.match(json, /Shortsword \+5/);
  assert.match(json, /Thieves' tools/);
  assert.match(json, /Bram the barkeep/);
  assert.match(json, /missing caravan/);
  assert.doesNotMatch(json, /doppelganger|cellar door/);
  const events = [];
  game.on("sheet", (s) => events.push(s));
  game.sheetChanged();
  assert.equal(events[0].sections[1].body, "- 12 gp\n- Thieves' tools");
});

test("storybook: transcripts as chapters plus journal notes; never DM Secrets; saved to storybooks/", async () => {
  const { game, table, dataDir } = setup();
  game.newCampaign("Other Tale");
  game.dm("A different story <script>alert(1)</script>");
  game.newCampaign("The Sunken Crown");
  table.map('new "Crypt" 6x6, 2x2-player, tok player1 name=Aria hp=9/12, 3x3-skeleton, tok skeleton1 hp=5/13');
  table.notesWrite("write", "campaign", null, null, { "Story Log": "- Fell into the crypt.", "DM Secrets": "The ferrywoman is the priest's daughter.", Quests: "- Find the crown" });
  game.dm("You wake on **cold stone**.\n\n- Your torch is out.");
  game.playerMessage("I light a match");
  const book = game.storybook();
  assert.match(book.html, /<h1>The Sunken Crown<\/h1>/);
  assert.match(book.html, /The story of Aria/);
  assert.match(book.html, /You wake on <strong>cold stone<\/strong>/);
  assert.match(book.html, /<li>Your torch is out\.<\/li>/);
  assert.match(book.html, /class="who">Aria<\/span>I light a match/);
  assert.match(book.html, /The story so far[\s\S]*Fell into the crypt/);
  assert.doesNotMatch(book.html, /priest's daughter|DM Secrets/);
  assert.doesNotMatch(book.html, /different story|<script>/, "other campaigns' transcripts stay out");
  assert.doesNotMatch(book.html, /5\/13|13 HP/);
  assert.ok(fs.existsSync(book.file) && path.dirname(book.file) === path.join(dataDir, "storybooks"));
});

// smallest valid PNG (1x1) and a JPEG header, as the page would send them (base64)
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("pictures: checked by their bytes, at most 3 per message, and they reach the DM with the message", async () => {
  const { game, dataDir } = setup();
  game.newCampaign("Pics");
  assert.throws(() => game.addImage(Buffer.from("<svg onload=alert(1)>").toString("base64")), /isn't a JPEG, PNG, GIF or WebP/);
  assert.throws(() => game.addImage(""), /empty/);
  const a = game.addImage(`data:image/png;base64,${PNG}`);
  game.addImage(PNG);
  const c = game.addImage(PNG);
  assert.throws(() => game.addImage(PNG), /up to 3 pictures/);
  game.removePendingImage(c);
  assert.equal(game.pendingImagesView().length, 2);
  assert.ok(fs.existsSync(path.join(dataDir, "images", `${a}.png`)));
  const p = game.turn({ say: "What is it?" });
  await tick();
  game.playerMessage("This is my sword");
  const r = await p;
  assert.equal(r.text, "This is my sword [2 pictures attached]");
  assert.equal(r.images.length, 2);
  assert.deepEqual(game.chat.at(-1).images, r.images);
  assert.equal(game.pendingImagesView().length, 0, "sent pictures leave the queue");
  // a picture alone is a message too
  game.addImage(PNG);
  assert.equal(game.playerMessage(""), true);
});

test("portrait and map pictures: shown on the sheet, token and map; the DM sees them with the next message", async () => {
  const { game, table } = setup();
  game.newCampaign("Faces");
  assert.throws(() => game.addImage(PNG, "map"), /no map yet/);
  table.map('new "Hall" 6x6, 2x2-player, tok player1 name=Aria');
  const face = game.addImage(PNG, "portrait");
  const bg = game.addImage(PNG, "map");
  assert.equal(game.player().portrait, face);
  const v = game.mapView();
  assert.equal(v.bg, bg);
  assert.equal(v.tokens.find((t) => t.side === "player").portrait, face);
  const p = game.turn({ say: "Go on." });
  await tick();
  game.playerMessage("Here's Aria and the hall");
  const r = await p;
  assert.match(r.text, /\[I set this picture as my character portrait\] \[I put this picture on the map 'Hall' as its background\]/);
  assert.deepEqual(r.images, [face, bg]);
  game.clearImage("map");
  assert.equal(game.mapView().bg, undefined);
  assert.equal(game.player().portrait, face, "the portrait stays");
  // the storybook embeds the portrait
  assert.match(game.storybook().html, /class="portrait" src="data:image\/png;base64,/);
});
