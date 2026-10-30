// Automatic, zero-token logging: one line per event in sessions/<YYYY-MM-DD_HHMM>.md, written
// with appendFileSync so every line is flushed as it happens. Optional transcripts (Claude Code
// mode) go to transcripts/<same stamp>.md. Callers must only pass player-safe text: no secret
// rolls, no enemy HP numbers, no DM Secrets.
import fs from "node:fs";
import path from "node:path";

const pad = (n) => String(n).padStart(2, "0");

export function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export class SessionLog {
  constructor(dataDir, { now = () => new Date() } = {}) {
    this.sessions = path.join(dataDir, "sessions");
    this.transcripts = path.join(dataDir, "transcripts");
    this.now = now;
    this.id = null;
    this.transcriptOn = false;
  }

  /** Start a new session file (every start/resume). Returns its stamp. */
  start({ transcript = false, title = "" } = {}) {
    fs.mkdirSync(this.sessions, { recursive: true });
    let id = stamp(this.now());
    for (let n = 2; fs.existsSync(path.join(this.sessions, `${id}.md`)); n++) id = `${stamp(this.now())}-${n}`;
    this.id = id;
    fs.writeFileSync(path.join(this.sessions, `${id}.md`), `# Session ${id}${title ? ` · ${title}` : ""}\n\n`);
    this.transcriptOn = transcript;
    if (transcript) this.#openTranscript(title);
    return id;
  }

  #openTranscript(title) {
    fs.mkdirSync(this.transcripts, { recursive: true });
    const f = path.join(this.transcripts, `${this.id}.md`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, `# Transcript ${this.id}${title ? ` · ${title}` : ""}\n\n`);
  }

  get file() {
    return this.id ? path.join(this.sessions, `${this.id}.md`) : null;
  }

  /** One flushed log line. Starts a session file lazily (Claude Desktop has no explicit start). */
  line(text) {
    if (!this.id) this.start();
    fs.appendFileSync(this.file, `${clock(this.now())} ${String(text).replace(/\s*\n\s*/g, " ")}\n`);
  }

  setTranscript(on) {
    this.transcriptOn = !!on;
    if (on && this.id) this.#openTranscript("");
  }

  /** Full narration and player messages, Claude Code mode only. Claude never reads these. */
  transcript(who, text) {
    if (!this.transcriptOn || !this.id) return;
    const label = who === "dm" ? "DM" : who === "player" ? "Player" : who;
    fs.appendFileSync(path.join(this.transcripts, `${this.id}.md`), `**${label}** (${clock(this.now())}): ${String(text).trim()}\n\n`);
  }

  /** Ids of the session files with stamp >= sinceStamp, oldest first. */
  recentIds(sinceStamp = "") {
    if (!fs.existsSync(this.sessions)) return [];
    return fs
      .readdirSync(this.sessions)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((id) => id >= sinceStamp)
      .sort();
  }

  /**
   * The last `n` event lines from earlier sessions of this campaign, oldest first, each prefixed
   * with its session stamp. `ids` lists the campaign's sessions; without it, every session since
   * `sinceStamp`. The current session is skipped.
   */
  recent(n = 30, sinceStamp = "", ids = null) {
    const mine = ids ? new Set(ids) : null;
    const files = this.recentIds(mine ? "" : sinceStamp)
      .filter((id) => id !== this.id && (!mine || mine.has(id)))
      .reverse();
    const out = [];
    for (const id of files) {
      const lines = fs.readFileSync(path.join(this.sessions, `${id}.md`), "utf8").split("\n").filter((l) => /^\d\d:\d\d:\d\d /.test(l));
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) out.push(`${id.slice(0, 10)} ${lines[i]}`);
      if (out.length >= n) break;
    }
    return out.reverse();
  }
}
