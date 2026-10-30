// The session flag file the Stop hook reads (<dataDir>/session.json). Written by the Claude
// Code mode server; the hook is a no-op unless a game is active in this very session.
import fs from "node:fs";
import path from "node:path";

export const flagPath = (dataDir) => path.join(dataDir, "session.json");

export function readFlag(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(flagPath(dataDir), "utf8"));
  } catch {
    return null;
  }
}

export function writeFlag(dataDir, patch) {
  const next = { ...(readFlag(dataDir) ?? {}), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${flagPath(dataDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  try {
    fs.renameSync(tmp, flagPath(dataDir));
  } catch {
    fs.copyFileSync(tmp, flagPath(dataDir));
    fs.rmSync(tmp, { force: true });
  }
  return next;
}
