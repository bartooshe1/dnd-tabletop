// The campaign service both front ends share (Claude Desktop extension and Claude Code mode):
// map batches, rolls and notes, plus the session log, the Story Log reminder, the one-app lock
// and reloading when the other app wrote the campaign. No MCP or UI code here.
import fs from "node:fs";
import path from "node:path";
import { execute } from "./executor.js";
import { CampaignStore } from "./store.js";
import { RoomStore } from "./rooms.js";
import { Notes } from "./notes.js";
import { rollSpec, rollText } from "./dice.js";
import { DICE_HISTORY, emptyCampaign } from "./model.js";
import { SessionLog, stamp } from "./sessionlog.js";
import { Lock } from "./lock.js";
import { fuzzyPick, slug } from "./fuzzy.js";
import { NotesError } from "./notes.js";
import { Shelf, titleOf } from "./shelf.js";

export const REMINDER = "reminder: the Story Log hasn't been updated since the last scene";

export class Table {
  constructor(config, { mode = "desktop", random = Math.random, now = Date.now } = {}) {
    this.config = config;
    this.mode = mode;
    this.random = random;
    this.now = now;
    this.store = new CampaignStore(config.dataDir);
    this.rooms = new RoomStore(path.join(config.dataDir, "rooms"));
    this.notes = new Notes(config.dataDir, mode);
    this.log = new SessionLog(config.dataDir);
    this.lock = new Lock(config.dataDir, mode);
    this.shelf = new Shelf(config.dataDir);
    this.notes.ensureFiles();
    this.campaign = this.store.load();
  }

  /** Before every tool call: take/refresh the lock (throws LockedError) and pick up outside writes. */
  enter() {
    this.lock.acquire();
    if (this.store.changedOnDisk()) this.campaign = this.store.load();
  }

  notice() {
    return this.store.takeNotice();
  }

  save() {
    this.store.save(this.campaign);
  }

  get meta() {
    this.campaign.meta ??= {};
    return this.campaign.meta;
  }

  /** Run a map batch. Atomic: on errors nothing changes. Logs player-safe events. */
  map(commands) {
    const res = execute(this.campaign, commands, {
      units: this.config.units,
      detail: this.config.detail,
      rooms: this.rooms,
      random: this.random,
    });
    if (!res.ok) {
      this.rooms.discardStaged();
      return res;
    }
    const info = [...res.info];
    const sceneChanged = res.events.some((e) => e.kind === "scene");
    this.campaign = res.campaign;
    if (sceneChanged) {
      const m = this.meta;
      if (m.sceneAt && !(m.storyLogAt > m.sceneAt)) info.push(REMINDER);
      m.sceneAt = this.now();
    }
    this.save();
    for (const e of res.effects) {
      if (e.kind === "saveRoom") {
        this.rooms.commit(e.room);
        this.notes.addSavedRoom(e.room.name);
      }
    }
    for (const e of res.events) this.log.line(e.text);
    return { ok: true, info, events: res.events, sceneChanged };
  }

  /** Roll dice (throws DiceError). Secret rolls are never stored and never logged. */
  roll(dice, { label, roller, mode, secret } = {}) {
    const rolls = rollSpec(dice, mode);
    if (label && rolls.length === 1 && !rolls[0].label) rolls[0].label = label;
    const lines = rolls.map(rollText);
    const body = `${label && rolls.length > 1 ? `${label}\n` : ""}${lines.join("\n")}`;
    if (secret) return { rolls, lines, body, secret: true };
    const entry = { t: this.now(), roller: roller ?? null, label: label ?? null, text: lines, rolls };
    this.campaign = { ...this.campaign, dice: [...this.campaign.dice, entry].slice(-DICE_HISTORY) };
    this.save();
    this.log.line(`roll${roller ? ` (${roller})` : ""}: ${lines.join("; ")}`);
    return { rolls, lines, body, entry };
  }

  history(n = 20) {
    return this.campaign.dice.slice(-n);
  }

  notesRead(file, section) {
    return this.notes.read(file, section);
  }

  /** write/append one section or many (`sections`). Logs section names only, never content. */
  notesWrite(op, file = "campaign", section, text, sections) {
    const names = sections ? this.notes.batch(op, file, sections) : [this.notes.update(op, file, section, text)];
    if (file === "campaign" && names.some((n) => slug(n) === "story_log")) {
      this.meta.storyLogAt = this.now();
      this.save();
    }
    this.log.line(`notes: ${op} ${file === "rules" ? "house rules " : ""}${names.join(", ")}`);
    return names;
  }

  /**
   * Start over without losing anything: copy the whole campaign folder (except older archives
   * and runtime files) to archive/<stamp>/, check the copy, then reset campaign.md and the map
   * state. House rules, saved rooms and old session logs stay where they are.
   */
  archiveAndReset(extraReset = []) {
    const dir = this.config.dataDir;
    const skip = new Set(["archive", "campaigns", "storybooks", "campaign.lock", "session.json"]);
    let dest = path.join(dir, "archive", stamp(new Date(this.now())));
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, "archive", `${stamp(new Date(this.now()))}-${n}`);
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (!skip.has(name)) fs.cpSync(path.join(dir, name), path.join(dest, name), { recursive: true });
    }
    for (const must of ["campaign.md", "campaign.json"]) {
      if (fs.existsSync(path.join(dir, must)) && !fs.existsSync(path.join(dest, must))) throw new Error(`archive copy failed for ${must}; nothing was reset`);
    }
    this.notes.resetCampaign();
    this.campaign = emptyCampaign();
    this.save();
    for (const f of extraReset) fs.rmSync(path.join(dir, f), { force: true }); // runtime files only (copied above)
    this.markStarted();
    return dest;
  }

  /** Mark a fresh campaign start (used to pick this campaign's session logs on resume). */
  markStarted() {
    this.meta.startedAt = this.now();
    this.meta.startedStamp = stamp(new Date(this.now()));
    this.save();
  }

  /** Start a session log (and transcript) and remember it as one of this campaign's sessions. */
  startSession({ transcript = false, title = "" } = {}) {
    const m = this.meta;
    // campaigns from before this list: their sessions are the ones since the campaign started
    m.sessions ??= this.log.recentIds(m.startedStamp ?? "");
    const id = this.log.start({ transcript, title });
    m.sessions = [...m.sessions, id].slice(-500);
    this.save();
    return id;
  }

  /** Session ids of this campaign, oldest first. */
  sessionIds() {
    return this.meta.sessions ?? this.log.recentIds(this.meta.startedStamp ?? "");
  }

  /** True if the active campaign has anything worth keeping. */
  hasContent(extra = []) {
    const c = this.campaign;
    return !!(c.maps.length || Object.keys(c.tokens).length || c.dice.length || !this.notes.isPristine() || extra.some((f) => fs.existsSync(path.join(this.config.dataDir, f))));
  }

  /** Other campaigns the player can switch to (titles are player-facing, nothing else is). */
  listCampaigns() {
    return this.shelf.list(this.meta.title ?? null);
  }

  /** Put the active campaign on the shelf. Returns its title. */
  shelveActive() {
    this.save();
    const title = this.meta.title ?? titleOf(this.config.dataDir);
    this.shelf.stash(title);
    return title;
  }

  /** Switch to a saved (or archived) campaign by name; the active one goes on the shelf first. */
  switchCampaign(name) {
    const list = this.listCampaigns();
    const pick = fuzzyPick(name, list, (c) => [c.title, c.id]);
    if (!pick.item) {
      const names = (pick.candidates?.length ? pick.candidates : list).map((c) => c.title);
      throw new NotesError(`no campaign '${name}'${names.length ? `; saved campaigns: ${names.join(", ")}` : "; there are no other saved campaigns"}`);
    }
    if (this.hasContent(["chat.json"])) this.shelveActive();
    this.shelf.restore(pick.item);
    this.campaign = this.store.load();
    if (!this.meta.title) this.meta.title = pick.item.title;
    this.save();
    return pick.item.title;
  }

  /** The player character: first token with side=player, with where it stands. */
  player() {
    const t = Object.values(this.campaign.tokens).find((x) => x.side === "player");
    return t ?? null;
  }
}
