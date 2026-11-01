// Page server: SSE snapshots, POST endpoints, and the security rules (Host, Origin, token, LAN).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { Table } from "../engine/table.js";
import { Game } from "../cc/game.js";
import { PageServer, lanAddresses } from "../cc/http.js";
import { connectSse, post } from "./sse.mjs";

let nextPort = 47920;
const servers = [];
after(async () => {
  for (const s of servers) await s.close();
});

async function setup({ lan = false, trustLoopback = false } = {}) {
  const dataDir = tmpDir();
  // trustLoopback=false: test requests come from this computer, but must be held to the LAN rules
  const config = { dataDir, units: "metric", detail: "lean", waitMs: 5000, idleStop: 3, port: nextPort, lan, lanBind: "127.0.0.1", openBrowser: false, trustLoopback };
  nextPort += 3;
  const table = new Table(config, { mode: "cc" });
  const game = new Game(table, config);
  const page = new PageServer(game, config, { page: "<!DOCTYPE html><title>test page</title>" });
  await page.start();
  servers.push(page);
  const origin = `http://127.0.0.1:${page.port}`;
  return { game, table, page, origin };
}

/** Raw request with a chosen Host header (fetch won't let us forge it). */
function raw(port, { method = "GET", path = "/", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

test("SSE: full snapshot on connect (map, chat, rolls, settings, token) and again on reconnect", async () => {
  const { game, table, origin } = await setup();
  game.newCampaign("Snap");
  table.map('new "Hall" 6x6, 2x2-player, tok player1 name=Aria hp=8/10');
  game.dm("Welcome.");
  game.trayRoll("d6");
  const a = await connectSse(`${origin}/events`);
  const snap = (await a.next("snapshot")).data;
  assert.equal(snap.map.name, "Hall");
  assert.equal(snap.chat.at(-2).text, "Welcome.");
  assert.equal(snap.rolls.length, 1);
  assert.equal(snap.player.name, "Aria");
  assert.equal(snap.state.title, "Snap");
  assert.match(snap.token, /^[\w-]{20,}$/);
  assert.equal(snap.pending.length, 1);
  a.close();
  game.dm("While you were away.");
  const b = await connectSse(`${origin}/events`);
  const snap2 = (await b.next("snapshot")).data;
  assert.equal(snap2.chat.at(-1).text, "While you were away.", "a reload loses nothing");
  b.close();
});

test("POST /api/say with token + origin unblocks a waiting turn; live events stream to the page", async () => {
  const { game, page, origin } = await setup();
  game.newCampaign();
  const sse = await connectSse(`${origin}/events`);
  const { token } = (await sse.next("snapshot")).data;
  const turn = game.turn({ say: "What now?", map: 'new "Road" 8x4, 2x2-player' });
  await sse.next("chat", (m) => m.text === "What now?");
  await sse.next("map", (m) => m.name === "Road");
  await sse.next("state", (s) => s.waiting);
  const r = await post(origin, "/api/say", { text: "I walk east" }, { token });
  assert.equal(r.status, 200);
  assert.equal((await turn).text, "(map: player1 2x2)\nI walk east");
  await sse.next("chat", (m) => m.who === "player" && m.text === "I walk east");
  const roll = await post(origin, "/api/roll", { dice: "d20" }, { token });
  assert.equal(roll.status, 200);
  await sse.next("roll", (e) => e.tray === true);
  await sse.next("pending", (p) => p.length === 1);
  assert.equal((await post(origin, "/api/roll", { dice: "d13" }, { token })).status, 400);
  assert.equal(page.clients.size, 1);
  sse.close();
});

test("security: Host header, token, origin, content type, body size", async () => {
  const { game, page, origin } = await setup();
  game.newCampaign();
  const sse = await connectSse(`${origin}/events`);
  const { token } = (await sse.next("snapshot")).data;
  sse.close();
  // DNS-rebinding style requests with a foreign Host are refused
  assert.equal(await raw(page.port, { headers: { host: `evil.example:${page.port}` } }), 421);
  assert.equal(await raw(page.port, { path: "/events", headers: { host: "attacker.test" } }), 421);
  assert.equal(await raw(page.port, { headers: { host: `localhost:${page.port}` } }), 200);
  // writes need the token AND an Origin matching this host
  assert.equal((await post(origin, "/api/say", { text: "x" })).status, 403);
  assert.equal((await post(origin, "/api/say", { text: "x" }, { token: "wrong-token-wrong-token-xx" })).status, 403);
  assert.equal((await post(origin, "/api/say", { text: "x" }, { token, originHeader: "http://evil.example" })).status, 403);
  assert.equal((await post(origin, "/api/say", { text: "x" }, { token, originHeader: null })).status, 403);
  assert.equal((await post(origin, "/api/say", { text: "x" }, { token, contentType: "text/plain" })).status, 415);
  const big = await fetch(`${origin}/api/say`, { method: "POST", headers: { "content-type": "application/json", "x-dnd-token": token, origin }, body: JSON.stringify({ text: "y".repeat(20000) }) });
  assert.equal(big.status, 413);
  assert.equal((await post(origin, "/api/say", { text: "fine" }, { token })).status, 200);
  // nothing else is served: no file access, no directory listing
  assert.equal((await fetch(`${origin}/../campaign.md`)).status, 404);
  assert.equal((await fetch(`${origin}/api/say`)).status, 404);
  assert.equal((await fetch(`${origin}/campaign.json`)).status, 404);
  const pageRes = await fetch(`${origin}/`);
  assert.match(pageRes.headers.get("content-security-policy"), /default-src 'none'.*connect-src 'self'/);
});

test("LAN mode: every request needs the token (page link, events, writes)", async () => {
  const { game, page, origin } = await setup({ lan: true });
  game.newCampaign();
  const t = page.token;
  assert.equal((await fetch(`${origin}/events`)).status, 403, "events without token");
  const sse = await connectSse(`${origin}/events?t=${t}`);
  assert.equal(sse.status, 200);
  sse.close();
  assert.equal((await fetch(`${origin}/?t=${t}`)).status, 200);
  for (const ip of lanAddresses().slice(0, 1)) {
    assert.equal(await raw(page.port, { headers: { host: `${ip}:${page.port}` } }), 403, "a LAN page needs ?t=");
    assert.equal(await raw(page.port, { path: `/?t=${t}`, headers: { host: `${ip}:${page.port}` } }), 200);
  }
  assert.equal((await post(origin, "/api/say", { text: "hi" })).status, 403);
  assert.equal((await post(origin, `/api/say?t=${t}`, { text: "hi" }, { token: t })).status, 200);
  const s = page.settingsPayload();
  assert.ok(Array.isArray(s.lanUrls));
  if (s.lanUrls.length) assert.match(s.lanQr, /^<svg/);
});

test("settings: units, typewriter, transcripts and LAN toggles round-trip through the page", async () => {
  const { game, origin } = await setup();
  game.newCampaign();
  const sse = await connectSse(`${origin}/events`);
  const { token } = (await sse.next("snapshot")).data;
  const r = await post(origin, "/api/settings", { units: "imperial", typewriter: false, transcripts: false, bogus: 1 }, { token });
  const s = await r.json();
  assert.deepEqual([s.units, s.typewriter, s.transcripts, s.bogus], ["imperial", false, false, undefined]);
  await sse.next("settings", (x) => x.units === "imperial");
  assert.equal(game.table.config.units, "imperial");
  sse.close();
});

test("Save & pause from the page returns [pause] to the waiting turn", async () => {
  const { game, origin } = await setup();
  game.newCampaign();
  const sse = await connectSse(`${origin}/events`);
  const { token } = (await sse.next("snapshot")).data;
  const turn = game.turn({ say: "Rest here?" });
  await sse.next("state", (s) => s.waiting);
  await post(origin, "/api/pause", {}, { token });
  assert.equal((await turn).text, "[pause]");
  game.pause();
  await sse.next("state", (s) => s.status === "paused");
  await sse.next("chat", (m) => m.who === "system" && /Saved/.test(m.text));
  sse.close();
});

test("two game servers never share a port, even when one is in LAN mode (Windows quirk)", async () => {
  const a = await setup();
  const dataDir = tmpDir();
  const config = { dataDir, units: "metric", detail: "lean", waitMs: 5000, idleStop: 3, port: a.page.port, lan: true, openBrowser: false };
  const game = new Game(new Table(config, { mode: "cc" }), config);
  const b = new PageServer(game, config, { page: "<!DOCTYPE html><title>b</title>" });
  await b.start();
  servers.push(b);
  assert.notEqual(b.port, a.page.port, "the second server moved to another port");
  assert.equal(await (await fetch(`http://127.0.0.1:${b.port}/__instance`)).text(), b.instance);
  assert.equal(await (await fetch(`http://127.0.0.1:${a.page.port}/__instance`)).text(), a.page.instance);
});

test("the page link stays the same between sessions; 'Make a new link' replaces it and cuts off old pages", async () => {
  const { game, page, origin } = await setup({ lan: true });
  const first = page.token;
  assert.equal(fs.readFileSync(path.join(game.config.dataDir, "page-token"), "utf8"), first);
  // a later session (new server, same data folder) gets the same link
  const again = new PageServer(game, { ...game.config, port: page.port + 1, lan: true, lanBind: "127.0.0.1" }, { page: "<!DOCTYPE html><title>b</title>" });
  assert.equal(again.token, first);
  const sse = await connectSse(`${origin}/events?t=${first}`);
  await sse.next("snapshot");
  const r = await post(origin, `/api/link/new?t=${first}`, {}, { token: first });
  const { token, settings } = await r.json();
  assert.notEqual(token, first);
  assert.ok(settings.lanUrls.every((u) => u.endsWith(`?t=${token}`)));
  assert.equal(page.clients.size, 0, "open pages and phones are disconnected");
  assert.equal((await fetch(`${origin}/events?t=${first}`)).status, 403, "the old link no longer works");
  assert.equal((await fetch(`${origin}/events?t=${token}`)).status, 200);
  assert.equal(fs.readFileSync(path.join(game.config.dataDir, "page-token"), "utf8"), token, "the new link is kept for next time");
  sse.close();
});

test("turning phone play on from the page: the reply arrives, the server comes back in LAN mode, and it's remembered", async () => {
  const { game, page, origin } = await setup();
  game.newCampaign();
  const sse = await connectSse(`${origin}/events`);
  const { token } = (await sse.next("snapshot")).data;
  const r = await post(origin, "/api/settings", { lan: true }, { token });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).lan, true, "the page is told right away");
  for (let i = 0; i < 40 && !(page.lan && page.server?.listening); i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(page.lan && page.server.listening, "the listener restarted in LAN mode");
  assert.equal((await fetch(`${origin}/events`)).status, 403, "LAN mode: reads need the token now");
  const again = await connectSse(`${origin}/events?t=${token}`);
  assert.equal((await again.next("snapshot")).data.settings.lan, true, "a reconnecting page sees it switched on");
  again.close();
  sse.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(game.config.dataDir, "settings.json"), "utf8")).lan, true);
});

test("on the game computer an old or broken link still works (the page learns the real one); other devices still need it", async () => {
  const { game, page, origin } = await setup({ lan: true, trustLoopback: true });
  game.newCampaign();
  assert.equal((await fetch(`${origin}/?t=old-or-cut-off`)).status, 200);
  const sse = await connectSse(`${origin}/events?t=old-or-cut-off`);
  assert.equal((await sse.next("snapshot")).data.token, page.token, "the snapshot carries the real token");
  sse.close();
  assert.deepEqual(await (await fetch(`${origin}/hello?t=old-or-cut-off`)).json(), { ok: false, lan: true });
  assert.deepEqual(await (await fetch(`${origin}/hello?t=${page.token}`)).json(), { ok: true, lan: true });
  assert.equal((await post(origin, "/api/say", { text: "hi" }, { token: "old-or-cut-off" })).status, 403, "writes still need the real token");
  // a LAN-style Host on a loopback socket is not trusted
  for (const ip of lanAddresses().slice(0, 1)) assert.equal(await raw(page.port, { path: "/events", headers: { host: `${ip}:${page.port}` } }), 403);
});

test("phone links: home Wi-Fi first, then Tailscale, then private VM/WSL addresses; WSL is detected", async () => {
  const { addressKind, inWsl } = await import("../cc/http.js");
  assert.deepEqual(["192.168.1.147", "10.0.0.5", "100.102.42.86", "172.29.199.193", "172.32.0.1"].map(addressKind), ["lan", "lan", "tailscale", "private", "lan"]);
  assert.equal(inWsl("6.18.54.1-microsoft-standard-WSL2"), true);
  assert.equal(inWsl("6.8.0-45-generic"), false);
  const ips = lanAddresses();
  const rank = { lan: 0, tailscale: 1, private: 2 };
  for (let i = 1; i < ips.length; i++) assert.ok(rank[addressKind(ips[i - 1])] <= rank[addressKind(ips[i])], `sorted: ${ips.join(", ")}`);
});

test("pictures over HTTP: upload needs the token, bad files are refused, LAN reads need the token", async () => {
  const { game, origin } = await setup({ lan: true });
  game.newCampaign();
  const t = game.pageToken();
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  assert.equal((await post(origin, "/api/image", { data: PNG })).status, 403, "no token, no upload");
  const bad = await post(origin, `/api/image?t=${t}`, { data: Buffer.from("not a picture").toString("base64") }, { token: t });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /isn't a JPEG/);
  const r = await post(origin, `/api/image?t=${t}`, { data: PNG }, { token: t });
  const { id } = await r.json();
  assert.match(id, /^[a-f0-9]{16}$/);
  assert.equal((await fetch(`${origin}/img/${id}`)).status, 403, "LAN: pictures need the token too");
  const img = await fetch(`${origin}/img/${id}?t=${t}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal((await fetch(`${origin}/img/../../campaign.json?t=${t}`)).status, 404);
  assert.equal((await fetch(`${origin}/img/0000000000000000?t=${t}`)).status, 404);
  const big = await post(origin, `/api/image?t=${t}`, { data: "A".repeat(10 * 1024 * 1024) }, { token: t });
  assert.equal(big.status, 413);
  assert.match((await fetch(`${origin}/?t=${t}`)).headers.get("content-security-policy"), /img-src 'self' data: blob:/);
});
