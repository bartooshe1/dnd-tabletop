// Claude Desktop extension: 4 tools (map, show_map, roll, notes) and 2 ui:// resources.
// The shared engine (Table) holds all state; the UI cards are stateless renderers of _meta data.
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { Table } from "../engine/table.js";
import { NotesError } from "../engine/notes.js";
import { DiceError } from "../engine/dice.js";
import { LockedError } from "../engine/lock.js";
import { activeMap } from "../engine/model.js";
import { buildMapView, mapText, shownLine, tokenListText, VIEW_KEY } from "../engine/view.js";
import { ROOT, UI_DIR } from "../engine/paths.js";
import { INSTRUCTIONS, MAP_DESC, NOTES_DESC, ROLL_DESC, SHOW_DESC } from "./descriptions.js";
import { log } from "../engine/log.js";

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
export const MAP_URI = "ui://dnd/map";
export const DICE_URI = "ui://dnd/dice";

function uiHtml(name) {
  const file = path.join(UI_DIR, `${name}.html`);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  log(`missing ${file}; run npm run build:ui`);
  return `<!DOCTYPE html><html><body style="font:13px sans-serif;color:#ccc;background:#222">dnd-tabletop: UI not built (${name}).</body></html>`;
}

const text = (t, extra = {}) => ({ content: [{ type: "text", text: t }], ...extra });

export function createServer(config, { random = Math.random } = {}) {
  const table = new Table(config, { mode: "desktop", random });
  const state = { uiSupported: false };

  const server = new McpServer({ name: "dnd-tabletop", version: PKG.version }, { instructions: INSTRUCTIONS });
  server.server.oninitialized = () => {
    const ui = getUiCapability(server.server.getClientCapabilities());
    state.uiSupported = !!ui?.mimeTypes?.includes(RESOURCE_MIME_TYPE);
    log(`client ${JSON.stringify(server.server.getClientVersion() ?? {})}, MCP Apps ${state.uiSupported ? "on" : "not advertised"}`);
  };

  const notice = (t) => {
    const n = table.notice();
    return n ? `${n}\n${t}` : t;
  };
  /** Lock + reload, then run `fn`; a lock held by Claude Code mode becomes a readable error. */
  const guarded = (fn) => async (args) => {
    try {
      table.enter();
    } catch (e) {
      if (e instanceof LockedError) return text(e.message, { isError: true });
      throw e;
    }
    return fn(args);
  };
  const resource = (uri) => async () => ({
    contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: uiHtml(uri === MAP_URI ? "map" : "dice"), _meta: { ui: { prefersBorder: false } } }],
  });
  registerAppResource(server, "D&D map", MAP_URI, { description: "Battle map card" }, resource(MAP_URI));
  registerAppResource(server, "D&D dice", DICE_URI, { description: "Animated dice card" }, resource(DICE_URI));

  // 1. map: silent edits (MCP Apps can't attach a card per call, so show_map renders)
  server.registerTool(
    "map",
    { description: MAP_DESC, inputSchema: { commands: z.string().describe("map commands") } },
    guarded(async ({ commands }) => {
      const res = table.map(commands);
      if (!res.ok) return text(notice(`nothing applied:\n${res.errors.join("\n")}`), { isError: true });
      return text(notice(res.info.length ? `ok; ${res.info.join("; ")}` : "ok"));
    }),
  );

  // 2. show_map: render the current map card
  registerAppTool(
    server,
    "show_map",
    {
      description: SHOW_DESC,
      inputSchema: { tokens: z.boolean().optional() },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: MAP_URI } },
    },
    guarded(async ({ tokens }) => {
      const campaign = table.campaign;
      const map = activeMap(campaign);
      const view = buildMapView(campaign, map, { units: config.units });
      const meta = { _meta: { [VIEW_KEY]: view } };
      if (!map) return text(notice('no map yet; start one with map: new "Name" 16x12'), meta);
      if (!state.uiSupported) {
        // Text fallback for hosts without MCP Apps: the model has to describe the map itself.
        return text(notice(`${mapText(campaign, map, config.units)}${tokens ? `\n${tokenListText(campaign, map)}` : ""}`), meta);
      }
      let out = shownLine(map, config.units);
      if (config.detail === "detailed" && map.caption) out += ` — ${map.caption}`;
      if (tokens) out += `\n${tokenListText(campaign, map)}`;
      return text(notice(out), meta);
    }),
  );

  // 3. roll: dice card with animation; secret rolls render nothing
  registerAppTool(
    server,
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
      _meta: { ui: { resourceUri: DICE_URI } },
    },
    guarded(async ({ dice, label, roller, mode, secret }) => {
      let r;
      try {
        r = table.roll(dice, { label, roller, mode, secret });
      } catch (e) {
        if (e instanceof DiceError) return text(e.message, { isError: true, _meta: { [VIEW_KEY]: { v: 1, kind: "dice", error: e.message, secret: !!secret } } });
        throw e;
      }
      if (r.secret) return text(`secret: ${r.body}`, { _meta: { [VIEW_KEY]: { v: 1, kind: "dice", secret: true } } });
      const history = table.campaign.dice.slice(-6, -1).reverse().map((h) => ({ roller: h.roller, label: h.label, text: h.text }));
      return text(r.body, {
        _meta: { [VIEW_KEY]: { v: 1, kind: "dice", label: label ?? null, roller: roller ?? null, mode: mode ?? null, rolls: r.rolls, history } },
      });
    }),
  );

  // 4. notes: markdown sections
  server.registerTool(
    "notes",
    {
      description: NOTES_DESC,
      inputSchema: {
        op: z.enum(["read", "write", "append"]).optional(),
        file: z.enum(["campaign", "rules"]).optional(),
        section: z.string().optional(),
        text: z.string().optional(),
        sections: z.record(z.string(), z.string()).optional(),
      },
    },
    guarded(async ({ op = "read", file = "campaign", section, text: body, sections }) => {
      try {
        if (op === "read") return text(notice(table.notesRead(file, section)));
        const names = table.notesWrite(op, file, section, body, sections);
        return text(config.detail === "detailed" ? `ok; ${op} ${names.join(", ")}` : "ok");
      } catch (e) {
        if (e instanceof NotesError) return text(e.message, { isError: true });
        throw e;
      }
    }),
  );

  return {
    server,
    state,
    table,
    get campaign() {
      return table.campaign;
    },
  };
}
