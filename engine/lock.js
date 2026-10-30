// One front end per campaign: campaign.lock in the data folder names the process using it.
// A holder counts while its process is alive and its heartbeat is fresh, so a crashed or
// quiet front end never blocks the other one for long.
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./store.js";

export const LOCK_TTL = { desktop: 5 * 60_000, cc: 2 * 60_000 };
const NAMES = { desktop: "Claude Desktop", cc: "Claude Code" };

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export class LockedError extends Error {}

export class Lock {
  constructor(dataDir, mode, { now = Date.now, pid = process.pid } = {}) {
    this.file = path.join(dataDir, "campaign.lock");
    this.mode = mode;
    this.now = now;
    this.pid = pid;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return null;
    }
  }

  /** The other live holder, or null if the campaign is free (or ours). */
  holder() {
    const h = this.read();
    if (!h || h.pid === this.pid) return null;
    const ttl = LOCK_TTL[h.mode] ?? LOCK_TTL.desktop;
    if (!pidAlive(h.pid) || this.now() - (h.heartbeat ?? 0) > ttl) return null;
    return h;
  }

  /** Take or refresh the lock; throws LockedError with a player-readable message if held. */
  acquire() {
    const h = this.holder();
    if (h) {
      const mins = Math.max(1, Math.round((this.now() - h.heartbeat) / 60_000));
      const other = NAMES[h.mode] ?? h.mode;
      const how =
        h.mode === "cc"
          ? "Click Save & pause on the game page (or close that Claude Code session) first."
          : `Wait about ${Math.ceil((LOCK_TTL.desktop - (this.now() - h.heartbeat)) / 60_000)} min, or quit Claude Desktop.`;
      throw new LockedError(`This campaign is open in ${other} (used ${mins} min ago). Only one app can run it at a time. ${how}`);
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ mode: this.mode, pid: this.pid, heartbeat: this.now() }));
  }

  release() {
    const h = this.read();
    if (h && h.pid === this.pid) fs.rmSync(this.file, { force: true });
  }
}
