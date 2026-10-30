// The local web page server for Claude Code mode. Binds 127.0.0.1 (LAN mode: 0.0.0.0).
// Server -> page: Server-Sent Events, full snapshot on every (re)connect.
// Page -> server: JSON POSTs that must carry the link's token and a matching Origin.
// Never reads or writes files: the page HTML arrives as a string, the token comes from the game.
import http from "node:http";
import os from "node:os";
import crypto from "node:crypto";
import { qrSvg } from "./qr.js";

const MAX_BODY = 16 * 1024;
const EVENTS = ["chat", "map", "roll", "state", "settings", "player", "pending", "sheet"];
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
};
const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

const isLoopback = (a) => typeof a === "string" && (a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127."));

/** This computer's mDNS name ("bar-pc.local"), if it is a plain host name. */
export function localName() {
  const n = os.hostname().toLowerCase().replace(/\.local$/, "");
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(n) ? `${n}.local` : null;
}

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class PageServer {
  constructor(game, config, { page, log = () => {} }) {
    this.game = game;
    this.config = config;
    this.page = page;
    this.log = log;
    this.token = game.pageToken?.() ?? crypto.randomBytes(24).toString("base64url");
    this.instance = crypto.randomBytes(8).toString("hex"); // not secret: tells two game servers apart
    this.clients = new Set();
    this.port = 0;
    this.lan = !!game.settings.lan;
    this.server = null;
    for (const ev of EVENTS) game.on(ev, (data) => this.broadcast(ev, ev === "settings" ? this.settingsPayload(data) : data));
    game.on("reset", () => this.broadcastSnapshot());
    // after the settings reply has gone out: restarting the listener must not cut it off
    game.on("lan", (on) => setTimeout(() => this.setLan(on).catch((e) => this.log(`LAN switch failed: ${e.message}`)), 150));
  }

  get localUrl() {
    return `http://127.0.0.1:${this.port}/?t=${this.token}`;
  }

  lanUrls() {
    return this.lan ? lanAddresses().map((ip) => `http://${ip}:${this.port}/?t=${this.token}`) : [];
  }

  /** http://<computer-name>.local:port/?t=…: stays the same even when the router hands out a new IP. */
  nameUrl() {
    const name = localName();
    return this.lan && name ? `http://${name}:${this.port}/?t=${this.token}` : null;
  }

  settingsPayload(settings = this.game.settings) {
    const urls = this.lanUrls();
    return { ...settings, lanUrls: urls, lanName: this.nameUrl(), lanQr: urls[0] ? qrSvg(urls[0], { scale: 4 }) : null };
  }

  /** A new secret link: every open page and phone is disconnected and needs the new one. */
  rotateToken() {
    this.token = this.game.newPageToken?.() ?? crypto.randomBytes(24).toString("base64url");
    for (const res of this.clients) res.end();
    this.clients.clear();
    this.log(`new page link: ${this.localUrl}`);
    return this.token;
  }

  snapshot() {
    return { ...this.game.snapshot(), settings: this.settingsPayload(), token: this.token, pending: [...this.game.pendingRolls] };
  }

  /** Start listening on the configured port, or the next free one (up to +20). */
  async start() {
    // LAN binds every interface; tests pass lanBind=127.0.0.1 to keep the token rules without a firewall prompt
    const host = this.lan ? (this.config.lanBind ?? "0.0.0.0") : "127.0.0.1";
    let port = this.port || this.config.port;
    for (let tries = 0; tries <= 20; tries++, port++) {
      try {
        await this.#listen(host, port);
        // Windows lets a 0.0.0.0 socket and a 127.0.0.1 socket share a port, and the browser then
        // reaches whichever is more specific. Make sure 127.0.0.1:port really is this process.
        if (!(await this.#isMe(port))) {
          await new Promise((r) => this.server.close(() => r()));
          this.server = null;
          if (this.port) throw Object.assign(new Error(`port ${port} is taken by another game server`), { code: "EADDRINUSE" });
          continue;
        }
        this.port = port;
        this.log(`page at ${this.localUrl}${this.lan ? ` (LAN: ${this.lanUrls().join(", ")})` : ""}`);
        return port;
      } catch (e) {
        if (e.code !== "EADDRINUSE" || this.port) throw e;
      }
    }
    throw new Error(`no free port from ${this.config.port} to ${this.config.port + 20}`);
  }

  /** Ask 127.0.0.1:port who it is, on a fresh socket (a pooled one may lead to a server we just closed). */
  #isMe(port) {
    return new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/__instance", agent: false, headers: { connection: "close" }, timeout: 1500 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(res.statusCode === 200 && body === this.instance));
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(false));
    });
  }

  #listen(host, port) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.#handle(req, res).catch((e) => {
        this.log(`http error: ${e.message}`);
        if (!res.headersSent) res.writeHead(500).end();
      }));
      srv.once("error", reject);
      srv.listen(port, host, () => {
        srv.off("error", reject);
        this.server = srv;
        resolve();
      });
    });
  }

  async setLan(on) {
    if (!!on === this.lan) return;
    const was = this.lan;
    this.lan = !!on;
    if (!this.server) return;
    await this.close();
    try {
      await this.start();
    } catch (e) {
      // the other mode can't listen (port taken?): stay playable the way it was, and say so
      this.log(`LAN switch failed: ${e.message}`);
      this.lan = was;
      await this.start();
      this.game.setSettings({ lan: was });
    }
  }

  async close() {
    for (const res of this.clients) res.end();
    this.clients.clear();
    const srv = this.server;
    this.server = null;
    if (!srv) return;
    const done = new Promise((r) => srv.close(() => r()));
    srv.closeAllConnections?.(); // browsers keep idle keep-alive sockets open; don't wait for them
    await done;
  }

  broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  broadcastSnapshot() {
    const frame = `event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  #hostOk(host) {
    if (typeof host !== "string") return false;
    const port = this.server?.address()?.port ?? this.port;
    const local = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (local.includes(host.toLowerCase())) return true;
    const name = localName();
    return this.lan && (lanAddresses().some((ip) => host === `${ip}:${port}`) || (!!name && host.toLowerCase() === `${name}:${port}`));
  }

  async #handle(req, res) {
    const host = req.headers.host;
    if (!this.#hostOk(host)) return res.writeHead(421, SECURITY_HEADERS).end("unknown host");
    const url = new URL(req.url, `http://${host}`);
    if (req.method === "GET" && url.pathname === "/__instance") return res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/plain" }).end(this.instance);
    // A request really made on this computer (loopback socket AND a loopback Host) is treated like
    // local mode even in LAN mode: reads are open and the page learns the token from the snapshot,
    // so an old or half-copied link still works here. Other devices always need the token.
    const fromHere = this.config.trustLoopback !== false && isLoopback(req.socket.remoteAddress) && /^(127\.0\.0\.1|localhost|\[::1\]):/.test(host);
    const tokenOk = same(url.searchParams.get("t") ?? req.headers["x-dnd-token"], this.token);
    if (this.lan && !tokenOk && !fromHere) return res.writeHead(403, SECURITY_HEADERS).end("token required");
    if (req.method === "GET" && url.pathname === "/hello") {
      return res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "application/json" }).end(JSON.stringify({ ok: tokenOk, lan: this.lan }));
    }

    if (req.method === "GET" && url.pathname === "/") {
      return res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_CSP }).end(this.page);
    }
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" });
      res.write(`retry: 2000\nevent: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
      this.clients.add(res);
      const ka = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(ka);
        this.clients.delete(res);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") return res.writeHead(204, SECURITY_HEADERS).end();
    if (req.method !== "POST" || !url.pathname.startsWith("/api/")) return res.writeHead(404, SECURITY_HEADERS).end();

    // Writes: token header + Origin that matches this exact host (blocks other sites' forms/fetches).
    if (!same(req.headers["x-dnd-token"], this.token)) return res.writeHead(403, SECURITY_HEADERS).end("bad token");
    if (req.headers.origin !== `http://${host}`) return res.writeHead(403, SECURITY_HEADERS).end("bad origin");
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return res.writeHead(415, SECURITY_HEADERS).end();
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) return res.writeHead(413, SECURITY_HEADERS).end();
      chunks.push(c);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      return res.writeHead(400, SECURITY_HEADERS).end("bad json");
    }
    const ok = (data) => res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "application/json" }).end(JSON.stringify(data ?? { ok: true }));
    switch (url.pathname) {
      case "/api/say":
        return this.game.playerMessage(body.text) ? ok() : res.writeHead(400, SECURITY_HEADERS).end("empty");
      case "/api/roll": {
        const entry = this.game.trayRoll(body.dice);
        return entry ? ok({ total: entry.rolls[0].total }) : res.writeHead(400, SECURITY_HEADERS).end("bad die");
      }
      case "/api/roll/clear":
        this.game.clearPendingRolls();
        return ok();
      case "/api/storybook": {
        const book = this.game.storybook();
        return ok({ name: book.name, file: book.file, html: book.html });
      }
      case "/api/link/new": {
        const token = this.rotateToken();
        return ok({ token, settings: this.settingsPayload() });
      }
      case "/api/pause":
        this.game.requestPause();
        return ok();
      case "/api/settings":
        return ok(this.settingsPayload(this.game.setSettings(body)));
      default:
        return res.writeHead(404, SECURITY_HEADERS).end();
    }
  }
}
