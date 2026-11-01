// Claude Code mode game loop, independent of MCP and HTTP so it can be tested directly.
// `turn` publishes narration and map edits to the page, then blocks until the player sends a
// message (or the wait times out). Emits "chat", "map", "roll", "state", "settings", "player",
// "images". Pictures the player adds ride along with their next message, so Claude sees them.
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { activeMap } from "../engine/model.js";
import { buildMapView } from "../engine/view.js";
import { writeFileAtomic } from "../engine/store.js";
import { writeFlag } from "./flag.js";
import { splitSections } from "../engine/notes.js";
import { slug } from "../engine/fuzzy.js";
import { titleOf } from "../engine/shelf.js";
import { stamp } from "../engine/sessionlog.js";
import { buildStorybook, readChapters } from "./storybook.js";
import { ImageError, ImageStore } from "./images.js";

export const MARK = { pause: "[pause]", idle: "[idle]", idleStop: "[idle-stop]", superseded: "[superseded]" };
const CHAT_MAX = 100;
const TRAY = /^(\d{0,2})d(4|6|8|10|12|20|100)$/;
const MAX_ATTACH = 3;
/** The only notes sections the page may ever show: the player's sheet and journal. Never DM Secrets. */
export const SHEET_SECTIONS = ["Character", "Inventory"];
export const JOURNAL_SECTIONS = ["Quests", "NPCs", "World Notes", "Story Log"];
const DEFAULT_SETTINGS = { typewriter: true, transcripts: true, units: "metric", lan: false };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export class Game extends EventEmitter {
  constructor(table, config, { now = Date.now } = {}) {
    super();
    this.table = table;
    this.config = config;
    this.now = now;
    const dir = config.dataDir;
    this.chatFile = path.join(dir, "chat.json");
    this.settingsFile = path.join(dir, "settings.json");
    const chat = readJson(this.chatFile, []);
    this.chat = Array.isArray(chat) ? chat.slice(-CHAT_MAX) : [];
    const saved = readJson(this.settingsFile, {});
    this.settings = { ...DEFAULT_SETTINGS, units: config.units, ...saved };
    if (config.lan) this.settings.lan = true;
    this.table.config.units = this.settings.units;
    this.status = "inactive"; // active | paused | idle-stop
    this.waiter = null;
    this.queue = [];
    this.pendingRolls = [];
    this.images = new ImageStore(dir);
    this.pendingImages = []; // [{ id, kind: "chat"|"portrait"|"map", map? }]
    this.idle = 0;
    this.pauseRequested = false;
    this.seq = this.chat.at(-1)?.id ?? 0;
    this.sceneKey = this.#sceneKey();
    writeFlag(dir, { active: false, paused: false, idleStop: false, pid: process.pid, lastTurnAt: 0, lastBlockAt: 0, ownerSession: null });
  }

  // ---------- the page link ----------

  /**
   * The secret in the page link (?t=). It is kept in page-token so the link (and a phone
   * bookmark) stays the same between sessions, until the player asks for a new one.
   */
  pageToken() {
    try {
      const t = fs.readFileSync(path.join(this.config.dataDir, "page-token"), "utf8").trim();
      if (/^[\w-]{32,}$/.test(t)) return t;
    } catch {
      /* first run */
    }
    return this.newPageToken();
  }

  newPageToken() {
    const t = crypto.randomBytes(24).toString("base64url");
    const file = path.join(this.config.dataDir, "page-token");
    try {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
      writeFileAtomic(file, t);
      fs.chmodSync(file, 0o600);
    } catch {
      /* the link still works for this session */
    }
    return t;
  }

  // ---------- what the page sees ----------

  mapView() {
    const map = activeMap(this.table.campaign);
    const v = buildMapView(this.table.campaign, map, { units: this.settings.units });
    if (v.empty) return v;
    if (map.bg && this.images.find(map.bg)) v.bg = map.bg;
    const portrait = this.portrait();
    if (portrait) for (const t of v.tokens) if (t.side === "player") t.portrait = portrait;
    return v;
  }

  portrait() {
    const id = this.table.meta.portrait;
    return id && this.images.find(id) ? id : null;
  }

  /** Name, HP and conditions of the player's own token (numbers are fine: it's theirs). */
  player() {
    const t = this.table.player();
    if (!t) return this.portrait() ? { id: null, name: null, hp: null, maxHp: null, status: [], portrait: this.portrait() } : null;
    return { id: t.id, name: t.name ?? null, hp: t.hp ?? null, maxHp: t.maxHp ?? null, status: [...(t.status ?? [])], portrait: this.portrait() };
  }

  /** Sheet and journal for the side panel: whitelisted campaign.md sections, comments removed. */
  sheet() {
    let doc;
    try {
      doc = splitSections(this.table.notes.load("campaign"));
    } catch {
      return { sections: [], journal: [] };
    }
    const pick = (names) =>
      names.map((name) => {
        const s = doc.sections.find((x) => slug(x.name) === slug(name));
        return { name, body: (s?.body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim() };
      });
    return { sections: pick(SHEET_SECTIONS), journal: pick(JOURNAL_SECTIONS) };
  }

  sheetChanged() {
    this.emit("sheet", this.sheet());
  }

  rolls(n = 20) {
    return this.table.history(n).map(({ t, roller, label, text, rolls }) => ({ t, roller, label, text, rolls }));
  }

  state() {
    return {
      status: this.status,
      waiting: !!this.waiter,
      pauseRequested: this.pauseRequested,
      idle: this.idle,
      idleStop: this.config.idleStop,
      title: this.table.meta.title ?? null,
    };
  }

  /** Everything a page needs after (re)connecting, so a reload or a sleeping phone loses nothing. */
  snapshot() {
    return { chat: this.chat.slice(-CHAT_MAX), map: this.mapView(), rolls: this.rolls(20), settings: { ...this.settings }, state: this.state(), player: this.player(), sheet: this.sheet(), campaigns: this.campaigns() };
  }

  #sceneKey() {
    const m = activeMap(this.table.campaign);
    return m ? `${m.name}|${m.caption ?? ""}` : "";
  }

  /** A scene divider in the chat when the active scene or its caption changes. */
  #sceneLine() {
    const key = this.#sceneKey();
    if (key === this.sceneKey) return;
    this.sceneKey = key;
    const m = activeMap(this.table.campaign);
    if (m) this.#push({ who: "scene", text: m.caption ? `${m.name} — ${m.caption}` : m.name });
  }

  #emitState() {
    this.emit("state", this.state());
  }

  #push(msg) {
    msg.id = ++this.seq;
    msg.t = this.now();
    this.chat.push(msg);
    if (this.chat.length > CHAT_MAX) this.chat.splice(0, this.chat.length - CHAT_MAX);
    try {
      writeFileAtomic(this.chatFile, JSON.stringify(this.chat));
    } catch {
      /* chat history is a convenience; never break the game over it */
    }
    this.emit("chat", msg);
    const pics = (msg.images ?? []).map((id) => this.images.find(id)?.name).filter(Boolean).map((n) => `[picture: ${n}]`);
    if (msg.who !== "system") this.table.log.transcript(msg.who === "roll" ? "Roll" : msg.who, [msg.text, ...pics].filter(Boolean).join(" "));
    return msg;
  }

  dm(text) {
    return this.#push({ who: "dm", text: String(text) });
  }

  // ---------- session ----------

  #activate() {
    this.status = "active";
    this.idle = 0;
    this.pauseRequested = false;
    writeFlag(this.config.dataDir, { active: true, paused: false, idleStop: false, pid: process.pid, lastTurnAt: this.now() });
    this.#emitState();
  }

  /** notes op=new: shelve the old campaign (it can be continued later) and archive a copy, then start fresh. */
  newCampaign(title) {
    this.table.enter();
    const hasContent = this.chat.length || this.table.hasContent();
    const shelved = hasContent ? this.table.shelveActive() : null;
    const archived = hasContent ? this.table.archiveAndReset(["chat.json"]) : (this.table.markStarted(), null);
    this.chat = [];
    this.sceneKey = "";
    if (title) {
      this.table.meta.title = String(title).slice(0, 80);
      this.table.save();
    }
    this.table.startSession({ transcript: this.settings.transcripts, title: title ?? "" });
    this.#activate();
    this.emit("reset", this.snapshot());
    return { archived, shelved };
  }

  /** notes op=resume with a name: shelve this campaign and bring that one back. Returns its title. */
  switchCampaign(name) {
    this.table.enter();
    if (this.waiter) this.#resolve(MARK.superseded);
    const title = this.table.switchCampaign(name);
    const chat = readJson(this.chatFile, []);
    this.chat = Array.isArray(chat) ? chat.slice(-CHAT_MAX) : [];
    this.seq = Math.max(this.seq, this.chat.at(-1)?.id ?? 0);
    this.queue = [];
    this.clearPendingRolls();
    this.pendingImages = [];
    this.emit("images", []);
    this.sceneKey = this.#sceneKey();
    return title;
  }

  /**
   * The campaign as a readable HTML storybook, also saved in storybooks/. Built from player-facing
   * text only: whitelisted notes sections and the transcripts (the chat if there are none).
   */
  storybook() {
    this.table.enter();
    const dir = this.config.dataDir;
    const title = this.table.meta.title || titleOf(dir);
    const hero = this.player()?.name || "the hero";
    const { sections, journal } = this.sheet();
    const order = ["Story Log", "Quests", "NPCs", "World Notes", "Character", "Inventory"];
    const label = { "Story Log": "The story so far", NPCs: "People met", "World Notes": "Places and lore" };
    const all = [...journal, ...sections];
    const notes = order.map((n) => all.find((s) => s.name === n)).filter(Boolean).map((s) => ({ name: label[s.name] ?? s.name, body: s.body }));
    let chapters = readChapters(dir, this.table.sessionIds(), this.table.meta.title ?? null);
    if (!chapters.length && this.chat.length) {
      const entries = this.chat
        .filter((m) => m.who !== "system")
        .map((m) => ({ who: m.who, text: [m.text, ...(m.images ?? []).map((id) => this.images.find(id)?.name).filter(Boolean).map((n) => `[picture: ${n}]`)].filter(Boolean).join(" ") }));
      chapters = [{ id: stamp(new Date(this.chat[0].t ?? this.now())), entries }];
    }
    const picture = (name) => this.images.dataUri(/^images\/([a-f0-9]{16})\./.exec(name)?.[1]);
    const portrait = this.portrait() ? this.images.dataUri(this.portrait()) : null;
    const html = buildStorybook({ title, hero, sections: notes, chapters, made: new Date(this.now()), picture, portrait });
    const name = `${slug(title) || "campaign"}-${stamp(new Date(this.now()))}.html`;
    const file = path.join(dir, "storybooks", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, html);
    return { html, name, file };
  }

  /** Saved campaigns for the page: titles only. */
  campaigns() {
    return this.table.listCampaigns().map((c) => ({ title: c.title, kind: c.kind, at: Math.round(c.at) || null }));
  }

  /** notes op=resume: new session file, same campaign. */
  resume() {
    this.table.enter();
    this.table.startSession({ transcript: this.settings.transcripts, title: this.table.meta.title ?? "" });
    this.#activate();
    this.emit("reset", this.snapshot());
  }

  /** notes op=pause: the session is over until /continuednd. */
  pause() {
    this.status = "paused";
    this.pauseRequested = false;
    if (this.waiter) this.#resolve(MARK.pause);
    this.table.save();
    writeFlag(this.config.dataDir, { active: false, paused: true });
    this.table.lock.release();
    this.#push({ who: "system", text: "Saved. Run /continuednd in Claude Code to play on." });
    this.#emitState();
  }

  /** Claude Code closed the server: let the hook and the other app know. */
  shutdown() {
    if (this.waiter) this.#resolve(MARK.pause);
    writeFlag(this.config.dataDir, { active: false });
    this.table.lock.release();
  }

  // ---------- the turn ----------

  /** Answer the waiting turn with a marker string or a player message { text, images }. */
  #resolve(reply) {
    const w = this.waiter;
    if (!w) return false;
    this.waiter = null;
    clearTimeout(w.timer);
    clearInterval(w.tick);
    w.resolve(typeof reply === "string" ? { text: reply, images: [] } : reply);
    this.#emitState();
    return true;
  }

  #drain() {
    const all = this.queue.splice(0);
    return { text: all.map((m) => m.text).join("\n"), images: all.flatMap((m) => m.images) };
  }

  /**
   * Publish `say` and apply `map`; then (if wait) block until the player answers.
   * Resolves { text, images, isError? } (images: picture ids the player sent). Throws LockedError
   * if the other app holds the campaign.
   */
  async turn({ say, map, wait = true } = {}, { progress, signal } = {}) {
    this.table.enter();
    if (wait && this.status !== "active") this.#activate();
    writeFlag(this.config.dataDir, { lastTurnAt: this.now() });
    const head = [];
    if (map && String(map).trim()) {
      const res = this.table.map(map);
      if (!res.ok) {
        if (say) this.dm(say);
        return { text: `map errors, nothing applied (say was shown):\n${res.errors.join("\n")}`, isError: true };
      }
      this.emit("map", this.mapView());
      this.emit("player", this.player());
      this.#sceneLine();
      if (res.info.length) head.push(`(map: ${res.info.join("; ")})`);
    }
    if (say && String(say).trim()) this.dm(say);
    const out = (t, images = []) => ({ text: [...head, t].filter(Boolean).join("\n") || "ok", images });
    if (!wait) return out("");
    if (this.pauseRequested) {
      this.pauseRequested = false;
      this.#emitState();
      return out(MARK.pause);
    }
    if (this.queue.length) {
      const m = this.#drain();
      return out(m.text, m.images);
    }
    if (this.waiter) this.#resolve(MARK.superseded);
    const reply = await new Promise((resolve) => {
      const since = this.now();
      const w = { resolve, since };
      w.timer = setTimeout(() => {
        this.idle++;
        if (this.idle >= this.config.idleStop) {
          this.status = "idle-stop";
          writeFlag(this.config.dataDir, { active: false, idleStop: true });
          this.#push({ who: "system", text: "DM paused. Run /continuednd in Claude Code to play on." });
          this.#resolve(MARK.idleStop);
        } else this.#resolve(MARK.idle);
      }, this.config.waitMs);
      if (progress) w.tick = setInterval(() => progress(this.now() - since), 30_000);
      signal?.addEventListener("abort", () => this.waiter === w && this.#resolve(MARK.superseded), { once: true });
      this.waiter = w;
      this.#emitState();
    });
    return out(reply.text, reply.images);
  }

  // ---------- from the page ----------

  /** A player message. Returns false if empty. Dice-tray rolls and added pictures ride along with it. */
  playerMessage(raw) {
    const text = String(raw ?? "").trim().slice(0, 2000);
    const pics = this.pendingImages.splice(0);
    if (!text && !pics.length) return false;
    this.#push({ who: "player", text, ...(pics.length ? { images: pics.map((p) => p.id) } : {}) });
    // a literal "[pause]" typed by the player must not look like a control marker
    const safe = /^\[(pause|idle|idle-stop|superseded)\]$/i.test(text) ? `"${text}"` : text;
    const rolls = this.pendingRolls.splice(0);
    const chatPics = pics.filter((p) => p.kind === "chat").length;
    const notes = [
      chatPics ? `[${chatPics} picture${chatPics > 1 ? "s" : ""} attached]` : null,
      pics.some((p) => p.kind === "portrait") ? "[I set this picture as my character portrait]" : null,
      ...pics.filter((p) => p.kind === "map").map((p) => `[I put this picture on the map '${p.map}' as its background]`),
    ];
    const full = [safe, ...rolls, ...notes].filter(Boolean).join(" ");
    if (rolls.length) this.emit("pending", []);
    if (pics.length) this.emit("images", []);
    this.idle = 0;
    if (this.status === "idle-stop") writeFlag(this.config.dataDir, { idleStop: false });
    const reply = { text: full, images: pics.map((p) => p.id) };
    if (!this.#resolve(reply)) this.queue.push(reply);
    this.#emitState();
    return true;
  }

  // ---------- pictures ----------

  pendingImagesView() {
    return this.pendingImages.map(({ id, kind }) => ({ id, kind }));
  }

  /**
   * Add a picture from the page. kind "chat": goes with the next message (max 3). "portrait": the
   * character's picture (sheet and map token). "map": the current map's background. The DM sees
   * portrait and map pictures with the next message too. Throws ImageError.
   */
  addImage(data, kind = "chat") {
    if (!["chat", "portrait", "map"].includes(kind)) throw new ImageError(`unknown picture kind '${kind}'`);
    if (kind === "chat" && this.pendingImages.filter((p) => p.kind === "chat").length >= MAX_ATTACH) throw new ImageError(`up to ${MAX_ATTACH} pictures per message`);
    this.table.enter();
    const map = kind === "map" ? activeMap(this.table.campaign) : null;
    if (kind === "map" && !map) throw new ImageError("there's no map yet to put a picture on");
    const id = this.images.save(data);
    if (kind === "portrait") {
      this.table.meta.portrait = id;
      this.pendingImages = this.pendingImages.filter((p) => p.kind !== "portrait");
    }
    if (kind === "map") {
      map.bg = id;
      this.pendingImages = this.pendingImages.filter((p) => !(p.kind === "map" && p.map === map.name));
    }
    if (kind !== "chat") {
      this.table.save();
      this.mapChanged();
    }
    this.pendingImages.push({ id, kind, ...(map ? { map: map.name } : {}) });
    this.emit("images", this.pendingImagesView());
    return id;
  }

  /** Take a picture back off the next message (a portrait or map picture stays set). */
  removePendingImage(id) {
    this.pendingImages = this.pendingImages.filter((p) => p.id !== id);
    this.emit("images", this.pendingImagesView());
  }

  /** Remove the character portrait or the current map's background picture. */
  clearImage(kind) {
    this.table.enter();
    if (kind === "portrait") delete this.table.meta.portrait;
    else if (kind === "map") {
      const map = activeMap(this.table.campaign);
      if (map) delete map.bg;
    } else throw new ImageError(`unknown picture kind '${kind}'`);
    this.pendingImages = this.pendingImages.filter((p) => p.kind !== kind);
    this.table.save();
    this.mapChanged();
    this.emit("images", this.pendingImagesView());
  }

  /** Dice tray: rolled on the server, attached to the player's next message. */
  trayRoll(dice) {
    const m = TRAY.exec(String(dice ?? "").trim().toLowerCase());
    if (!m || Number(m[1] || 1) < 1 || Number(m[1] || 1) > 10) return null;
    const who = this.player()?.name ?? "player";
    const r = this.table.roll(`${m[1] || 1}d${m[2]}`, { roller: who });
    const g = r.rolls[0].groups[0];
    const desc = g.rolls.length > 1 ? `${g.rolls.join("+")} = ${r.rolls[0].total}` : `${r.rolls[0].total}`;
    this.pendingRolls.push(`[rolled ${r.rolls[0].expr}: ${desc}]`);
    this.emit("roll", { ...r.entry, tray: true });
    this.#push({ who: "roll", text: `${who} rolled ${r.lines[0]}` });
    this.emit("pending", [...this.pendingRolls]);
    return r.entry;
  }

  clearPendingRolls() {
    this.pendingRolls = [];
    this.emit("pending", []);
  }

  /** A roll Claude made with the `roll` tool (never a secret one). */
  claudeRoll(entry) {
    this.emit("roll", entry);
    this.#push({ who: "roll", text: `${entry.roller ? `${entry.roller}: ` : ""}${entry.text.join(" · ")}` });
  }

  /** Map edits from the silent `map` tool still show up live on the page. */
  mapChanged() {
    this.emit("map", this.mapView());
    this.emit("player", this.player());
    this.#sceneLine();
  }

  requestPause() {
    if (this.status !== "active") return;
    if (!this.#resolve(MARK.pause)) this.pauseRequested = true;
    this.#push({ who: "system", text: "Saving…" });
    this.#emitState();
  }

  setSettings(patch = {}) {
    const next = { ...this.settings };
    if (typeof patch.typewriter === "boolean") next.typewriter = patch.typewriter;
    if (typeof patch.transcripts === "boolean") next.transcripts = patch.transcripts;
    if (patch.units === "metric" || patch.units === "imperial") next.units = patch.units;
    if (typeof patch.lan === "boolean") next.lan = patch.lan;
    const lanChanged = next.lan !== this.settings.lan;
    this.settings = next;
    this.table.config.units = next.units;
    this.table.log.setTranscript(next.transcripts && this.status === "active");
    try {
      writeFileAtomic(this.settingsFile, JSON.stringify(next));
    } catch {
      /* settings still apply for this session */
    }
    this.emit("settings", { ...next });
    if (lanChanged) this.emit("lan", next.lan);
    this.mapChanged();
    return next;
  }
}
