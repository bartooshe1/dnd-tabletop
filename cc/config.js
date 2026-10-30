// Claude Code mode settings from the environment. The data folder and units are shared with
// the Claude Desktop extension (engine/config.js); the rest is specific to the turn loop.
import { loadConfig } from "../engine/config.js";

const num = (v) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

/**
 * How long one `turn` call may wait for the player.
 * Claude Code moves a main-conversation MCP call that runs past CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS
 * (default 120000, v2.1.212+) into a background task, so by default we return [idle] just before
 * that. With auto-backgrounding off ("0") we can wait the full 10 minutes.
 */
export function waitMs(env = process.env) {
  const explicit = num(env.DND_WAIT_MS);
  if (explicit !== undefined) return Math.max(1000, explicit);
  const bg = num(env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS);
  if (bg === 0) return 600_000;
  if (bg !== undefined && bg > 0) return Math.max(10_000, Math.min(600_000, bg - 10_000));
  return 110_000;
}

/** Consecutive [idle] results before [idle-stop]: 3 at 10-minute waits, scaled to ~30 minutes otherwise. */
export function idleStopCount(env = process.env, wait = waitMs(env)) {
  const explicit = num(env.DND_IDLE_STOP);
  if (explicit !== undefined) return Math.max(1, Math.round(explicit));
  const minutes = num(env.DND_IDLE_STOP_MIN) ?? 30;
  return Math.max(1, Math.ceil((minutes * 60_000) / wait));
}

export function loadCcConfig(env = process.env) {
  const base = loadConfig(env);
  const wait = waitMs(env);
  return {
    ...base,
    port: num(env.DND_PORT) ?? 47800,
    lan: env.DND_LAN === "1" || env.DND_LAN === "true",
    lanBind: env.DND_LAN_BIND || undefined, // advanced: interface LAN mode listens on (default all)
    openBrowser: !(env.DND_NO_BROWSER === "1" || env.DND_NO_BROWSER === "true"),
    waitMs: wait,
    idleStop: idleStopCount(env, wait),
  };
}
