// Claude Code mode: one process, MCP over stdio (turn, map, roll, notes) plus the local page
// server. The shared engine (Table) holds the campaign; Game runs the turn loop.
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Table } from "../engine/table.js";
import { NotesError } from "../engine/notes.js";
import { DiceError } from "../engine/dice.js";
import { LockedError } from "../engine/lock.js";
import { activeMap } from "../engine/model.js";
import { tokenListText } from "../engine/view.js";
import { UI_DIR } from "../engine/paths.js";
import { log } from "../engine/log.js";
import { Game } from "./game.js";
import { PageServer } from "./http.js";
import { openBrowser } from "./browser.js";
import { INSTRUCTIONS, MAP_DESC, NOTES_DESC, ROLL_DESC, TURN_DESC } from "./descriptions.js";

export const VERSION = "0.4.4";
const text = (t, extra = {}) => ({ content: [{ type: "text", text: t }], ...extra });

function pageHtml() {
  const file = path.join(UI_DIR, "play.html");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  log(`missing ${file}; run npm run build:ui`);
  return "<!DOCTYPE html><title>D&D</title><body style='background:#111;color:#ccc;font:14px sans-serif'>The game page isn't built (npm run build:ui).";
}

export function createCcServer(config, { random = Math.random, browser = openBrowser } = {}) {
  const table = new Table(config, { mode: "cc", random });
  const game = new Game(table, config);
  const page = new PageServer(game, config, { page: pageHtml(), log });
  const ready = page.start();
  let opened = false;

  /** Open the page once per session, and only if no page is connected yet. */
  const showPage = async () => {
    await ready;
    if (!config.openBrowser || page.clients.size || opened) return;
    opened = true;
    try {
      browser(page.localUrl);
    } catch (e) {
      log(`could not open the browser: ${e.message}`);
    }
  };

  const server = new McpServer({ name: "dnd-tabletop-cc", version: VERSION }, { instructions: INSTRUCTIONS });
  server.server.oninitialized = () => log(`client ${JSON.stringify(server.server.getClientVersion() ?? {})}; turn waits ${config.waitMs / 1000}s, idle-stop after ${config.idleStop}`);

  const guard = (fn) => async (args, extra) => {
    try {
      return await fn(args, extra);
    } catch (e) {
      if (e instanceof LockedError || e instanceof NotesError || e instanceof DiceError) return text(e.message, { isError: true });
      throw e;
    }
  };

  server.registerTool(
    "turn",
    {
      description: TURN_DESC,
      inputSchema: { say: z.string().optional(), map: z.string().optional(), wait: z.boolean().optional() },
    },
    guard(async (args, extra) => {
      await ready;
      if (!page.clients.size) showPage();
      const token = extra?._meta?.progressToken;
      const progress =
        token === undefined
          ? undefined
          : (ms) => extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ms, message: "waiting for the player" } }).catch(() => {});
      const r = await game.turn(args, { progress, signal: extra?.signal });
      return text(r.text, r.isError ? { isError: true } : {});
    }),
  );

  server.registerTool(
    "map",
    { description: MAP_DESC, inputSchema: { commands: z.string() } },
    guard(async ({ commands }) => {
      table.enter();
      const res = table.map(commands);
      if (!res.ok) return text(`nothing applied:\n${res.errors.join("\n")}`, { isError: true });
      game.mapChanged();
      return text(res.info.length ? `ok; ${res.info.join("; ")}` : "ok");
    }),
  );

  server.registerTool(
    "roll",
    {
      description: ROLL_DESC,
      inputSchema: {
        dice: z.string(),
        label: z.string().optional(),
        roller: z.string().optional(),
        mode: z.enum(["adv", "dis"]).optional(),
        secret: z.boolean().optional(),
      },
    },
    guard(async ({ dice, label, roller, mode, secret }) => {
      table.enter();
      const r = table.roll(dice, { label, roller, mode, secret });
      if (r.secret) return text(`secret: ${r.body}`);
      game.claudeRoll(r.entry);
      return text(r.body);
    }),
  );

  server.registerTool(
    "notes",
    {
      description: NOTES_DESC,
      inputSchema: {
        op: z.enum(["read", "write", "append", "new", "resume", "pause"]).optional(),
        file: z.enum(["campaign", "rules"]).optional(),
        section: z.string().optional(),
        text: z.string().optional(),
        sections: z.record(z.string(), z.string()).optional(),
      },
    },
    guard(async ({ op = "read", file = "campaign", section, text: body, sections }) => {
      if (op === "pause") {
        game.pause();
        return text("ok; paused and saved. Say goodbye in one line, then end your response.");
      }
      if (op === "new" || op === "resume") {
        let made = null;
        let switched = null;
        if (op === "new") made = game.newCampaign(body);
        else {
          if (body?.trim()) switched = game.switchCampaign(body.trim());
          game.resume();
        }
        opened = false;
        await showPage();
        const parts = [`Page: ${page.localUrl}  (give the player this link in one line)`];
        if (made?.shelved) parts.push(`Previous campaign '${made.shelved}' saved; the player can continue it with /continuednd ${made.shelved}`);
        if (switched) parts.push(`Switched to the saved campaign '${switched}'. The one before is saved too.`);
        parts.push(`=== house rules ===\n${table.notesRead("rules")}`);
        if (op === "new") parts.push(`=== campaign.md (fresh template) ===\n${table.notes.load("campaign").trim()}`);
        else {
          parts.push(`=== campaign.md ===\n${table.notesRead("campaign", "all")}`);
          const recent = table.log.recent(30, table.meta.startedStamp ?? "", table.sessionIds());
          parts.push(`=== last ${recent.length} session log lines ===\n${recent.join("\n") || "(none)"}`);
          const map = activeMap(table.campaign);
          if (map) parts.push(`=== current scene: ${map.name} ${map.cols}x${map.rows} ===\n${tokenListText(table.campaign, map)}`);
        }
        const others = game.campaigns().map((c) => c.title);
        if (others.length) parts.push(`Other saved campaigns: ${others.join(", ")} (switch with /continuednd <name>)`);
        if (game.queue.length) parts.push(`(the player wrote while you were away; your first turn call returns it)`);
        return text(parts.join("\n\n"));
      }
      table.enter();
      if (op === "read") return text(table.notesRead(file, section));
      const names = table.notesWrite(op, file, section, body, sections);
      if (file === "campaign") game.sheetChanged();
      return text(config.detail === "detailed" ? `ok; ${op} ${names.join(", ")}` : "ok");
    }),
  );

  return { server, table, game, page, ready };
}
