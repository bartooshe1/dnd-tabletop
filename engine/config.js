// Runtime config from env (set by the manifest's user_config) with per-OS defaults.
import os from "node:os";
import path from "node:path";

export const APP_DIR = "dnd-tabletop";

export function defaultDataDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), APP_DIR);
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_DIR);
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), APP_DIR);
}

/** Hosts may pass an unset user_config through literally ("${user_config.x}") or as "". */
function clean(v) {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return !s || s.includes("${") ? undefined : s;
}

export function loadConfig(env = process.env) {
  const detail = clean(env.DND_DETAIL)?.toLowerCase();
  const units = clean(env.DND_UNITS)?.toLowerCase();
  return {
    dataDir: clean(env.DND_DATA_DIR) ?? defaultDataDir(),
    detail: detail === "detailed" ? "detailed" : "lean",
    units: units === "imperial" || units === "feet" || units === "ft" ? "imperial" : "metric",
  };
}
