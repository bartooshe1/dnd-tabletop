// notes sections, persistence and corrupt-file recovery, config
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { Notes, NotesError, splitSections } from "../engine/notes.js";
import { CampaignStore } from "../engine/store.js";
import { emptyCampaign, createMap } from "../engine/model.js";
import { loadConfig, defaultDataDir } from "../engine/config.js";

test("notes: files created from templates with all sections", () => {
  const dir = tmpDir();
  const n = new Notes(dir);
  n.ensureFiles();
  const names = splitSections(fs.readFileSync(path.join(dir, "campaign.md"), "utf8")).sections.map((s) => s.name);
  assert.deepEqual(names, ["Current State", "Character", "Inventory", "Story Log", "NPCs", "Quests", "World Notes", "DM Secrets", "Saved rooms"]);
  const rules = n.read("rules");
  assert.match(rules, /Follow D&D 5e rules\. Miss nothing, never fudge dice/);
  assert.match(rules, /12\. Homebrew is welcome[\s\S]*13\. Balance for a solo character/);
  assert.match(rules, /## Player notes/);
  assert.match(fs.readFileSync(path.join(dir, "house_rules.md"), "utf8"), /<!-- Add your own rules/);
  assert.doesNotMatch(rules, /I'm new to D&D|<!--/, "commented examples are not sent to Claude as rules");
});

test("notes: default read is Current State only; all returns the whole file", () => {
  const n = new Notes(tmpDir());
  n.update("write", "campaign", "Current State", "At the Midnight Inn, evening.");
  assert.equal(n.read(), "## Current State\nAt the Midnight Inn, evening.");
  const all = n.read("campaign", "all");
  assert.match(all, /## Character/);
  assert.match(all, /At the Midnight Inn/);
});

test("notes: write replaces, append adds, sections are matched by name", () => {
  const n = new Notes(tmpDir());
  n.update("write", "campaign", "inventory", "- 12 gp");
  n.update("append", "campaign", "Inventory", "- rope (15 m)");
  assert.equal(n.read("campaign", "Inventory"), "## Inventory\n- 12 gp\n- rope (15 m)");
  n.update("write", "campaign", "Inventory", "- 10 gp");
  assert.equal(n.read("campaign", "Inventory"), "## Inventory\n- 10 gp");
  // fuzzy section names for reading
  assert.match(n.read("campaign", "story"), /^## Story Log/);
  // writing a new section creates it before Saved rooms
  n.update("write", "campaign", "Session Notes", "first session");
  const names = splitSections(n.load("campaign")).sections.map((s) => s.name);
  assert.deepEqual(names.slice(-2), ["Session Notes", "Saved rooms"]);
  // other sections untouched
  assert.match(n.read("campaign", "Character"), /Name, race, class/);
  assert.throws(() => n.read("campaign", "zzzz"), NotesError);
  assert.throws(() => n.update("append", "campaign", "Inventory", "  "), NotesError);
  assert.throws(() => n.update("write", "campaign", undefined, "x"), NotesError);
});

test("notes: saved rooms list gets names only, no duplicates", () => {
  const n = new Notes(tmpDir());
  n.addSavedRoom("The Midnight Inn");
  n.addSavedRoom("The Midnight Inn");
  n.addSavedRoom("Old Mill");
  const s = n.read("campaign", "Saved rooms");
  assert.equal((s.match(/The Midnight Inn/g) ?? []).length, 1);
  assert.match(s, /- Old Mill/);
});

test("notes: the player's edits are never overwritten by templates", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "house_rules.md"), "# My rules\n## Rules\nbe nice\n");
  const n = new Notes(dir);
  n.ensureFiles();
  assert.equal(n.read("rules"), "# My rules\n\n## Rules\nbe nice");
  assert.match(fs.readFileSync(path.join(dir, "house_rules.md"), "utf8"), /^# My rules\n## Rules\nbe nice\n$/, "file untouched");
});

test("store: save/load round trip, atomic file, backup", () => {
  const dir = tmpDir();
  const s = new CampaignStore(dir);
  const c = emptyCampaign();
  c.maps.push(createMap("A", 5, 5));
  c.active = "A";
  s.save(c);
  s.save(c);
  assert.deepEqual(new CampaignStore(dir).load(), c);
  assert.ok(fs.existsSync(path.join(dir, "campaign.json.bak")));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("store: corrupt file recovers from backup, keeps the bad file aside", () => {
  const dir = tmpDir();
  const s = new CampaignStore(dir);
  const c = emptyCampaign();
  c.maps.push(createMap("Good", 5, 5));
  c.active = "Good";
  s.save(c);
  s.save(c); // .bak now holds the good state
  fs.writeFileSync(path.join(dir, "campaign.json"), "{ not json");
  const s2 = new CampaignStore(dir);
  const loaded = s2.load();
  assert.equal(loaded.active, "Good");
  assert.match(s2.takeNotice(), /restored the previous save/);
  assert.equal(s2.takeNotice(), null, "notice is shown once");
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("campaign.json.corrupt-")));
});

test("store: corrupt file with no backup starts fresh", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "campaign.json"), '{"maps": 7}');
  const s = new CampaignStore(dir);
  assert.deepEqual(s.load(), emptyCampaign());
  assert.match(s.takeNotice(), /started a fresh map state/);
});

test("config: defaults per OS, env overrides, unsubstituted placeholders ignored", () => {
  assert.equal(defaultDataDir("win32", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "C:\\Users\\x"), path.join("C:\\Users\\x\\AppData\\Roaming", "dnd-tabletop"));
  assert.equal(defaultDataDir("darwin", {}, "/Users/x"), path.join("/Users/x", "Library", "Application Support", "dnd-tabletop"));
  assert.equal(defaultDataDir("linux", { XDG_DATA_HOME: "/data" }, "/home/x"), path.join("/data", "dnd-tabletop"));
  assert.equal(defaultDataDir("linux", {}, "/home/x"), path.join("/home/x", ".local", "share", "dnd-tabletop"));
  assert.deepEqual(loadConfig({ DND_DETAIL: "detailed", DND_UNITS: "imperial", DND_DATA_DIR: "/tmp/x" }), { dataDir: "/tmp/x", detail: "detailed", units: "imperial" });
  const d = loadConfig({ DND_DETAIL: "${user_config.detail}", DND_UNITS: "", DND_DATA_DIR: "${user_config.data_dir}" });
  assert.equal(d.detail, "lean");
  assert.equal(d.units, "metric");
  assert.equal(d.dataDir, defaultDataDir());
});
