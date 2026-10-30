// Shared campaign service: session logs, Story Log reminder, lock file, archive-on-new.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { Table, REMINDER } from "../engine/table.js";
import { Lock, LockedError } from "../engine/lock.js";
import { SessionLog } from "../engine/sessionlog.js";

const cfg = (dataDir) => ({ dataDir, units: "metric", detail: "lean" });
const sessionText = (dir) => {
  const d = path.join(dir, "sessions");
  return fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), "utf8")).join("\n");
};

test("session log: one line per event, player numbers, wound words for enemies, no secret rolls", () => {
  const dir = tmpDir();
  const t = new Table(cfg(dir));
  t.log.start();
  assert.ok(t.map('new "Crypt" 10x8, 2x2-player, tok player1 hp=17/23 name=Aria, 4x4-skeleton, tok skeleton1 hp=3/13 status=prone, player1 > 3x3').ok);
  t.roll("1d20+5 atk", { roller: "Aria" });
  t.roll("1d20+2 morale", { secret: true, label: "goblin morale" });
  t.notesWrite("write", "campaign", null, null, { "Current State": "In the crypt.", "DM Secrets": "The priest is a lich." });
  assert.ok(t.map("4x4-empty").ok);
  const log = sessionText(dir);
  assert.match(log, /^# Session \d{4}-\d\d-\d\d_\d{4}/m);
  assert.match(log, /\d\d:\d\d:\d\d new scene 'Crypt' 10x8/);
  assert.match(log, /player1 named Aria; HP 17\/23/);
  assert.match(log, /skeleton1 looks badly wounded; status prone/);
  assert.match(log, /player1 moved 2x2→3x3/);
  assert.match(log, /roll \(Aria\): atk 1d20\+5: \[\d+\]\+5 = \d+/);
  assert.match(log, /notes: write Current State, DM Secrets/);
  assert.match(log, /skeleton1 removed from 4x4/);
  for (const line of log.split("\n").filter((l) => /skeleton/.test(l))) assert.doesNotMatch(line.slice(9), /\d+\s*\/\s*\d+|hp\b/i, `no enemy HP numbers: ${line}`);
  assert.doesNotMatch(log, /3\/13/);
  assert.doesNotMatch(log, /morale|secret/, "no secret rolls");
  assert.doesNotMatch(log, /lich/, "no DM Secrets content");
  assert.equal(t.history().length, 1, "secret roll not in history");
});

test("session log: a new file on every start; recent() reads earlier sessions of this campaign only", () => {
  const dir = tmpDir();
  let clock = new Date(2026, 9, 25, 10, 0, 0);
  const log = new SessionLog(dir, { now: () => clock });
  const a = log.start();
  log.line("old campaign event");
  clock = new Date(2026, 9, 25, 11, 0, 0);
  const b = log.start();
  for (let i = 1; i <= 40; i++) log.line(`event ${i}`);
  clock = new Date(2026, 9, 25, 12, 0, 0);
  const c = log.start();
  log.line("current session event");
  assert.notEqual(a, b);
  assert.equal(fs.readdirSync(path.join(dir, "sessions")).length, 3);
  const recent = log.recent(30, b);
  assert.equal(recent.length, 30);
  assert.match(recent[0], /event 11$/);
  assert.match(recent.at(-1), /event 40$/);
  assert.ok(!recent.some((l) => /current session|old campaign/.test(l)));
  assert.equal(log.recent(30, "2026-10-25_1100").length, 30);
  // same minute: a second start gets a suffix instead of overwriting
  const c2 = log.start();
  assert.equal(c2, `${c}-2`);
});

test("transcripts only when switched on", () => {
  const dir = tmpDir();
  const log = new SessionLog(dir);
  log.start({ transcript: false });
  log.transcript("dm", "You enter the crypt.");
  assert.equal(fs.existsSync(path.join(dir, "transcripts")), false);
  log.setTranscript(true);
  log.transcript("dm", "You enter the crypt.");
  log.transcript("player", "I light a torch");
  const t = fs.readFileSync(path.join(dir, "transcripts", `${log.id}.md`), "utf8");
  assert.match(t, /\*\*DM\*\* \(\d\d:\d\d:\d\d\): You enter the crypt\./);
  assert.match(t, /\*\*Player\*\* .*I light a torch/);
});

test("Story Log reminder on a scene change when the Story Log wasn't updated since the last scene", () => {
  let now = 1000;
  const t = new Table(cfg(tmpDir()), { now: () => now });
  const first = t.map('new "Inn" 8x8');
  assert.ok(!first.info.includes(REMINDER), "no reminder for the very first scene");
  now += 1000;
  const second = t.map('new "Road" 10x6');
  assert.ok(second.info.includes(REMINDER));
  now += 1000;
  t.notesWrite("append", "campaign", "Story Log", "Left the inn.");
  now += 1000;
  const third = t.map('new "Forest" 10x10');
  assert.ok(!third.info.includes(REMINDER), "updated since the last scene");
  now += 1000;
  assert.ok(!t.map("2x2-player, player1 > 3x3").info.includes(REMINDER), "moves are not scene changes");
  assert.ok(t.map('use "Inn"').info.includes(REMINDER));
});

test("lock: one front end at a time, clear message, stale and own locks don't block", () => {
  const dir = tmpDir();
  let now = 1_000_000;
  const desktop = new Lock(dir, "desktop", { now: () => now, pid: process.pid });
  desktop.acquire();
  const cc = new Lock(dir, "cc", { now: () => now, pid: process.ppid });
  // the holder is "us" from desktop's view, but cc (a different pid) is blocked
  assert.throws(() => cc.acquire(), (e) => e instanceof LockedError && /open in Claude Desktop/.test(e.message));
  now += 6 * 60_000; // desktop heartbeat older than its 5 min TTL
  cc.acquire();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "campaign.lock"), "utf8")).mode, "cc");
  // a dead pid never blocks
  fs.writeFileSync(path.join(dir, "campaign.lock"), JSON.stringify({ mode: "cc", pid: 2 ** 22 + 12345, heartbeat: now }));
  desktop.acquire();
  desktop.release();
  assert.equal(fs.existsSync(path.join(dir, "campaign.lock")), false);
});

test("Table refuses to run while the other app holds the campaign", () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "campaign.lock"), JSON.stringify({ mode: "cc", pid: process.ppid, heartbeat: Date.now() }));
  const t = new Table(cfg(dir));
  assert.throws(() => t.enter(), /open in Claude Code.*Save & pause/);
});

test("Table picks up campaign changes written by the other app", () => {
  const dir = tmpDir();
  const a = new Table(cfg(dir));
  const b = new Table(cfg(dir), { mode: "cc" });
  a.enter();
  a.map('new "Shared" 6x6, 2x2-player');
  a.lock.release();
  b.enter();
  assert.equal(b.campaign.active, "Shared");
  b.map("player1 > 3x3");
  b.lock.release();
  a.enter();
  assert.equal(a.campaign.maps[0].tokens[2][2], "player1");
});

test("archive on new never deletes: everything is copied first, then campaign.md and the map reset", () => {
  const dir = tmpDir();
  const t = new Table(cfg(dir));
  t.log.start();
  t.map('new "Old" 6x6, 2x2-player, save "Old Hall"');
  t.notesWrite("write", "campaign", "Story Log", "The old story.");
  fs.writeFileSync(path.join(dir, "chat.json"), "[1,2,3]");
  const dest = t.archiveAndReset(["chat.json"]);
  for (const f of ["campaign.md", "campaign.json", "chat.json", "house_rules.md", path.join("rooms", "old_hall.json")]) {
    assert.ok(fs.existsSync(path.join(dest, f)), `${f} archived`);
  }
  assert.match(fs.readFileSync(path.join(dest, "campaign.md"), "utf8"), /The old story\./);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "campaign.md"), "utf8"), /The old story\./, "fresh campaign.md");
  assert.equal(t.campaign.maps.length, 0);
  assert.ok(fs.existsSync(path.join(dir, "rooms", "old_hall.json")), "saved rooms stay available");
  assert.ok(fs.existsSync(path.join(dir, "house_rules.md")), "house rules are kept");
  assert.equal(fs.existsSync(path.join(dir, "chat.json")), false);
  assert.ok(fs.readdirSync(path.join(dir, "sessions")).length >= 1, "session logs are kept");
  // a second archive in the same minute never overwrites the first
  const dest2 = t.archiveAndReset();
  assert.notEqual(dest2, dest);
  assert.ok(fs.existsSync(path.join(dest, "campaign.md")));
  assert.ok(t.campaign.meta.startedStamp);
});

test("rules: Claude Desktop skips the Claude Code section, Claude Code mode adds it if missing", () => {
  const dir = tmpDir();
  const desk = new Table(cfg(dir));
  assert.match(fs.readFileSync(path.join(dir, "house_rules.md"), "utf8"), /## Claude Code mode/, "created as base + cc");
  assert.doesNotMatch(desk.notesRead("rules"), /Claude Code mode|`turn`/);
  const cc = new Table(cfg(dir), { mode: "cc" });
  assert.match(cc.notesRead("rules"), /## Claude Code mode[\s\S]*`turn`/);
  // an older file without the section still gets the cc rules in cc mode
  fs.writeFileSync(path.join(dir, "house_rules.md"), "# House Rules\n\n## Rules\n1. Be fair.\n");
  assert.match(cc.notesRead("rules"), /1\. Be fair\.[\s\S]*## Claude Code mode/);
  assert.doesNotMatch(desk.notesRead("rules"), /Claude Code mode/);
  // an older Claude Code section keeps the player's lines and gains the newer rules once
  fs.writeFileSync(path.join(dir, "house_rules.md"), "# House Rules\n\n## Claude Code mode\n- My own rule.\n- After a context compaction, call `notes` op=read file=rules once.\n");
  const rules = cc.notesRead("rules");
  assert.match(rules, /- My own rule\.[\s\S]*player's journal[\s\S]*`init next`/);
  assert.equal(rules.match(/context compaction/g).length, 1, "lines already there are not repeated");
});
