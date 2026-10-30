// SPIKE (Claude Code mode): one `turn` tool that publishes narration + map edits to a local
// page and BLOCKS until the player types there. Verifies blocking, timeouts, permissions and
// the Stop hook in real Claude Code before the full build. Runs from the repo (no bundle).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execute } from "../engine/executor.js";
import { emptyCampaign, activeMap } from "../engine/model.js";
import { RoomStore } from "../engine/rooms.js";
import { buildMapView } from "../engine/view.js";
import { defaultDataDir } from "../engine/config.js";

const log = (m) => process.stderr.write(`[dnd-spike] ${m}\n`);
const DATA = process.env.DND_DATA_DIR || `${defaultDataDir()}-spike`;
const WAIT_MS = Number(process.env.DND_WAIT_MS || 600000);
const IDLE_STOP = Number(process.env.DND_IDLE_STOP || 3);
const PORT0 = Number(process.env.DND_PORT || 47800);
const FLAG = path.join(DATA, "session.json");
fs.mkdirSync(DATA, { recursive: true });

const token = crypto.randomBytes(16).toString("hex");
let campaign = emptyCampaign();
const rooms = new RoomStore(null);
const chat = [];
const clients = new Set();
const queue = [];
let waiter = null;
let idle = 0;
let pauseRequested = false;
let port = 0;
let opened = false;
const diag = { started: Date.now(), turns: 0, lastWaitMs: 0, waitingSince: null, client: null, autoBackgroundEnv: process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS ?? "(unset)", waitMs: WAIT_MS };

function flag(patch) {
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(FLAG, "utf8"));
  } catch {}
  const next = { ...cur, ...patch, pid: process.pid };
  fs.writeFileSync(FLAG, JSON.stringify(next));
  return next;
}
flag({ active: false, paused: false, idleStop: false, lastTurnAt: 0, ownerSession: null, lastBlockAt: 0 });

function hookLog() {
  try {
    return fs.readFileSync(path.join(DATA, "hook.log"), "utf8").trim().split("\n").slice(-8);
  } catch {
    return [];
  }
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}
const mapView = () => buildMapView(campaign, activeMap(campaign), { units: "metric" });
const state = () => ({ waiting: !!waiter, idle, idleStop: idle >= IDLE_STOP, paused: pauseRequested, diag: { ...diag, hook: hookLog(), now: Date.now() } });

function resolveWaiter(text) {
  if (!waiter) return false;
  const w = waiter;
  waiter = null;
  clearTimeout(w.timer);
  clearInterval(w.progress);
  diag.lastWaitMs = Date.now() - w.since;
  diag.waitingSince = null;
  w.resolve(text);
  broadcast("state", state());
  return true;
}

function openBrowser(url) {
  if (opened || clients.size || process.env.DND_NO_BROWSER) return;
  opened = true;
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (e) {
    log(`could not open browser: ${e.message}`);
  }
}

// ---------- MCP ----------
const server = new McpServer(
  { name: "dnd-spike", version: "0.0.1" },
  { instructions: "Spike of the D&D Claude Code mode. Talk to the player only through the turn tool." },
);
server.server.oninitialized = () => {
  diag.client = server.server.getClientVersion() ?? null;
  log(`client ${JSON.stringify(diag.client)}`);
};

server.registerTool(
  "turn",
  {
    description:
      "Publish narration (say) and map commands (map) to the player's page, then wait for the player's next message and return it. Special returns: [pause], [idle] (call turn again), [idle-stop] (stop).",
    inputSchema: { say: z.string().optional(), map: z.string().optional(), wait: z.boolean().optional() },
  },
  async ({ say, map, wait = true }, extra) => {
    diag.turns++;
    // a wait=false call (e.g. the goodbye after [pause]) must not re-activate a paused game
    flag(wait ? { active: true, paused: false, idleStop: false, lastTurnAt: Date.now() } : { lastTurnAt: Date.now() });
    const url = `http://127.0.0.1:${port}/?t=${token}`;
    let mapNote = "";
    if (map) {
      const res = execute(campaign, map, { units: "metric", detail: "lean", rooms, random: Math.random });
      if (!res.ok) {
        if (say) chat.push({ who: "dm", text: say, t: Date.now() }), broadcast("chat", chat.at(-1));
        return { content: [{ type: "text", text: `map errors (nothing applied):\n${res.errors.join("\n")}` }], isError: true };
      }
      campaign = res.campaign;
      broadcast("map", mapView());
      if (res.info.length) mapNote = `map: ok; ${res.info.join("; ")}\n`;
    }
    if (say) {
      chat.push({ who: "dm", text: say, t: Date.now() });
      broadcast("chat", chat.at(-1));
    }
    openBrowser(url);
    if (!wait) return { content: [{ type: "text", text: `${mapNote}ok (page: ${url})` }] };
    if (pauseRequested) {
      pauseRequested = false;
      flag({ paused: true, active: false });
      return { content: [{ type: "text", text: `${mapNote}[pause]` }] };
    }
    if (queue.length) {
      idle = 0;
      return { content: [{ type: "text", text: mapNote + queue.splice(0).join("\n") }] };
    }
    if (waiter) resolveWaiter("[superseded]");
    const text = await new Promise((resolve) => {
      const since = Date.now();
      diag.waitingSince = since;
      const progressToken = extra?._meta?.progressToken;
      waiter = {
        resolve,
        since,
        timer: setTimeout(() => {
          idle++;
          if (idle >= IDLE_STOP) flag({ idleStop: true, active: false });
          resolveWaiter(idle >= IDLE_STOP ? "[idle-stop]" : "[idle]");
        }, WAIT_MS),
        progress: progressToken !== undefined
          ? setInterval(() => {
              extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: Date.now() - since, message: "waiting for the player" } }).catch(() => {});
            }, 30000)
          : null,
      };
      broadcast("state", state());
    });
    if (!text.startsWith("[")) idle = 0;
    return { content: [{ type: "text", text: mapNote + text }] };
  },
);

// ---------- HTTP ----------
const PAGE = fs.readFileSync(new URL("./page.html", import.meta.url), "utf8");
const okHost = (h) => [`127.0.0.1:${port}`, `localhost:${port}`].includes(h);

const web = http.createServer(async (req, res) => {
  if (!okHost(req.headers.host)) return res.writeHead(403).end("bad host");
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PAGE);
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    clients.add(res);
    send(res, "snapshot", { token, chat: chat.slice(-100), map: mapView(), state: state() });
    const ka = setInterval(() => {
      res.write(": keep-alive\n\n");
      send(res, "state", state());
    }, 5000);
    req.on("close", () => {
      clearInterval(ka);
      clients.delete(res);
    });
    return;
  }
  if (req.method === "POST") {
    if (req.headers["x-dnd-token"] !== token || req.headers.origin !== `http://${req.headers.host}`) return res.writeHead(403).end("bad token");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (url.pathname === "/api/say" && typeof body.text === "string" && body.text.trim()) {
      const text = body.text.trim().slice(0, 2000);
      chat.push({ who: "player", text, t: Date.now() });
      broadcast("chat", chat.at(-1));
      idle = 0;
      flag({ idleStop: false });
      if (!resolveWaiter(text)) queue.push(text);
      return res.writeHead(204).end();
    }
    if (url.pathname === "/api/pause") {
      pauseRequested = true;
      if (resolveWaiter("[pause]")) {
        pauseRequested = false;
        flag({ paused: true, active: false });
      }
      return res.writeHead(204).end();
    }
  }
  res.writeHead(404).end();
});

function listen(p) {
  web.once("error", (e) => {
    if (e.code === "EADDRINUSE" && p < PORT0 + 20) listen(p + 1);
    else log(`http error ${e.message}`);
  });
  web.listen(p, "127.0.0.1", () => {
    port = p;
    fs.writeFileSync(path.join(DATA, "url.txt"), `http://127.0.0.1:${port}/?t=${token}\n`);
    log(`page at http://127.0.0.1:${port}/?t=${token}`);
  });
}
listen(PORT0);

await server.connect(new StdioServerTransport());
process.on("exit", () => flag({ active: false }));
process.stdin.on("end", () => process.exit(0)); // Claude Code closed the session
log(`ready; data ${DATA}; wait ${WAIT_MS} ms; idle-stop after ${IDLE_STOP}`);
