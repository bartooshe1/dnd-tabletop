// SPIKE Stop hook: while a game runs, block Claude from ending its response and tell it to
// call `turn`. No-op when no game runs, when paused/idle-stopped, for other sessions, or when
// the loop guard says we already blocked and Claude made no progress since.
import fs from "node:fs";
import path from "node:path";
import { defaultDataDir } from "../engine/config.js";

const DATA = process.env.DND_DATA_DIR || `${defaultDataDir()}-spike`;
const FLAG = path.join(DATA, "session.json");
const LOG = path.join(DATA, "hook.log");
const say = (m) => fs.appendFileSync(LOG, `${new Date().toISOString().slice(11, 19)} ${m}\n`);

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch {}
let flag = null;
try {
  flag = JSON.parse(fs.readFileSync(FLAG, "utf8"));
} catch {}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function allow(why) {
  say(`allow (${why})`);
  process.exit(0);
}

if (!flag || !flag.active) allow("no active game");
if (flag.paused || flag.idleStop) allow("paused or idle");
if (!alive(flag.pid)) allow("server not running");
if (flag.ownerSession && input.session_id && flag.ownerSession !== input.session_id) allow("other session");
if (input.stop_hook_active && !(flag.lastTurnAt > (flag.lastBlockAt || 0))) allow("loop guard: no turn since last block");
const next = { ...flag, lastBlockAt: Date.now(), ownerSession: flag.ownerSession || input.session_id || null };
fs.writeFileSync(FLAG, JSON.stringify(next));
say(`block (stop_hook_active=${!!input.stop_hook_active})`);
process.stdout.write(
  JSON.stringify({ decision: "block", reason: "The game is running. Call `turn` to continue, or `turn` with wait=false if the player asked to stop." }),
);
