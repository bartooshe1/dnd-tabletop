#!/usr/bin/env node
// Optional extras for Claude Code mode, each after its own y/N question (default No):
//  1. bare-name /startdnd and /continuednd in ~/.claude/commands (the plugin's own are
//     /dnd-tabletop:startdnd and /dnd-tabletop:continuednd)
//  2. allow rules for the 4 game tools in ~/.claude/settings.json (no permission prompts)
//  3. CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0 in the same file, so `turn` can wait 10 minutes
// settings.json is backed up before any change. Nothing is ever deleted.
// Usage: node scripts/install.mjs [--yes] [--dry-run] [--config-dir <dir>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const TOOLS = ["turn", "map", "roll", "notes"].map((t) => `mcp__plugin_dnd-tabletop_dnd__${t}`);
export const ENV_KEY = "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS = path.join(HERE, "..", "plugin", "commands");

export function configDir(argv = process.argv, env = process.env) {
  const i = argv.indexOf("--config-dir");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error(`${file} isn't valid JSON (${e.message}); fix it or add the rules by hand (see README)`);
  }
}

/** Pure: the settings object with our allow rules and/or env var added (idempotent). */
export function withAdditions(settings, { permissions = false, env = false } = {}) {
  const next = structuredClone(settings);
  if (permissions) {
    next.permissions ??= {};
    next.permissions.allow ??= [];
    for (const t of TOOLS) if (!next.permissions.allow.includes(t)) next.permissions.allow.push(t);
  }
  if (env) {
    next.env ??= {};
    next.env[ENV_KEY] = "0";
  }
  return next;
}

function backup(file, dry) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${file}.bak-dnd-${stamp}`;
  if (!dry) fs.copyFileSync(file, bak);
  return bak;
}

export async function install({ argv = process.argv, ask, log = (m) => process.stdout.write(`${m}\n`) } = {}) {
  const yes = argv.includes("--yes");
  const dry = argv.includes("--dry-run");
  const dir = configDir(argv);
  const confirm = async (q) => (yes ? true : /^y(es)?$/i.test((await ask(`${q} [y/N] `)).trim()));
  const done = [];

  log(`Claude Code config folder: ${dir}${dry ? "  (dry run: nothing is written)" : ""}`);

  // 1. bare-name commands
  const cmdDir = path.join(dir, "commands");
  if (await confirm(`1) Add /startdnd and /continuednd to ${cmdDir}?`)) {
    for (const f of ["startdnd.md", "continuednd.md"]) {
      const target = path.join(cmdDir, f);
      if (fs.existsSync(target) && fs.readFileSync(target, "utf8") !== fs.readFileSync(path.join(COMMANDS, f), "utf8")) {
        if (!(await confirm(`   ${target} exists and is different. Replace it? (a backup is kept)`))) continue;
        if (!dry) fs.copyFileSync(target, `${target}.bak-dnd`);
      }
      if (!dry) {
        fs.mkdirSync(cmdDir, { recursive: true });
        fs.copyFileSync(path.join(COMMANDS, f), target);
      }
      done.push(`command ${f}`);
    }
  }

  // 2 + 3. settings.json
  const settingsFile = path.join(dir, "settings.json");
  const wantPerms = await confirm(`2) Allow the 4 game tools without asking (adds ${TOOLS.length} rules to ${settingsFile})?`);
  const wantEnv = await confirm(
    `3) Let turn wait 10 minutes for you instead of ~2 (sets ${ENV_KEY}=0 in ${settingsFile}; it stops Claude Code from moving ANY long MCP call to the background)?`,
  );
  if (wantPerms || wantEnv) {
    const before = readSettings(settingsFile);
    const after = withAdditions(before, { permissions: wantPerms, env: wantEnv });
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      const bak = backup(settingsFile, dry);
      if (!dry) {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${settingsFile}.tmp-dnd`;
        fs.writeFileSync(tmp, `${JSON.stringify(after, null, 2)}\n`);
        fs.renameSync(tmp, settingsFile);
      }
      if (bak) log(`   backup: ${bak}`);
      if (wantPerms) done.push("tool allow rules");
      if (wantEnv) done.push(`${ENV_KEY}=0`);
    } else log("   settings.json already has these entries");
  }

  log(done.length ? `Done: ${done.join(", ")}. Restart Claude Code to apply.` : "Nothing changed.");
  return done;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await install({ ask: (q) => rl.question(q) });
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}
