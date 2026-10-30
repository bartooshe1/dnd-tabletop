// Claude Code Stop hook: while a game runs in THIS session, keep Claude from ending its response
// (the game would freeze) and tell it to call `turn`. Allows the stop when no game is active,
// the game is paused or idle-stopped, the server is gone, it's another session, or the loop
// guard says we already blocked once and Claude made no progress (no `turn` call) since.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../engine/config.js";
import { pidAlive } from "../engine/lock.js";
import { readFlag, writeFlag } from "./flag.js";

export const REASON = "The game is running. Call `turn` to continue, or `notes` op=pause if the player asked to stop.";
const TURN_TOOL = /mcp__[\w-]*dnd[\w-]*__turn/;

/** Did this session's transcript call our turn tool? (binds the hook to the game's session) */
export function transcriptUsesTurn(file) {
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return TURN_TOOL.test(buf.toString("utf8"));
  } catch {
    return false;
  }
}

/** Pure decision: returns { block: boolean, why: string, patch?: object }. */
export function decide(input, flag, { now = Date.now(), alive = pidAlive, usesTurn = transcriptUsesTurn } = {}) {
  if (!flag || !flag.active) return { block: false, why: "no active game" };
  if (flag.paused || flag.idleStop) return { block: false, why: "paused or idle" };
  if (!alive(flag.pid)) return { block: false, why: "game server not running" };
  const sid = input?.session_id ?? null;
  if (flag.ownerSession && sid && flag.ownerSession !== sid) return { block: false, why: "another session" };
  if (!flag.ownerSession && !(input?.transcript_path && usesTurn(input.transcript_path))) return { block: false, why: "this session isn't running the game" };
  if (input?.stop_hook_active && !((flag.lastTurnAt ?? 0) > (flag.lastBlockAt ?? 0))) return { block: false, why: "loop guard: no turn call since the last block" };
  return { block: true, why: "game running", patch: { lastBlockAt: now, ownerSession: flag.ownerSession ?? sid } };
}

export function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    /* no input: treat as a plain stop */
  }
  const { dataDir } = loadConfig();
  const flag = readFlag(dataDir);
  const d = decide(input, flag);
  if (process.env.DND_HOOK_LOG) fs.appendFileSync(path.join(dataDir, "hook.log"), `${new Date().toISOString()} ${d.block ? "block" : "allow"} (${d.why})\n`);
  if (!d.block) return;
  writeFlag(dataDir, d.patch);
  process.stdout.write(JSON.stringify({ decision: "block", reason: REASON }));
}
