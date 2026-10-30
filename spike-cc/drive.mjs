// Plays the part of the browser page against a running spike server: reads url.txt from the
// data dir, follows the SSE stream, answers each DM message from a script, then pauses.
// Usage: node spike-cc/drive.mjs <dataDir> [idleGapMs]
import fs from "node:fs";
import path from "node:path";

const dataDir = process.argv[2];
const idleGap = Number(process.argv[3] || 0);
const script = ["I walk to 3x4", "I look around", idleGap ? "__idle__" : null, "__pause__"].filter(Boolean);
const t0 = Date.now();
const log = (m) => console.log(`[drive +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

let url;
for (let i = 0; i < 240 && !url; i++) {
  try {
    url = new URL(fs.readFileSync(path.join(dataDir, "url.txt"), "utf8").trim());
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!url) throw new Error("server never wrote url.txt");
log(`page ${url.origin}`);

let token = null;
const post = (p, body) =>
  fetch(new URL(p, url.origin), { method: "POST", headers: { "content-type": "application/json", "x-dnd-token": token, origin: url.origin }, body: JSON.stringify(body ?? {}) });

const res = await fetch(new URL("/events", url.origin));
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let step = 0;
let dmCount = 0;
async function onEvent(ev, data) {
  if (ev === "snapshot") token = data.token;
  if (ev === "chat" && data.who === "dm") {
    dmCount++;
    log(`DM: ${data.text}`);
    const next = script[step++];
    if (!next) return;
    if (next === "__idle__") {
      log(`staying silent for ${idleGap / 1000}s to trigger [idle]`);
      setTimeout(async () => {
        log("player: back again");
        await post("/api/say", { text: "back again" });
      }, idleGap);
      return;
    }
    if (next === "__pause__") {
      log("clicking Save & pause");
      await post("/api/pause");
      return;
    }
    log(`player: ${next}`);
    const r = await post("/api/say", { text: next });
    if (r.status !== 204) log(`POST failed ${r.status}`);
  }
  if (ev === "map") log(`map update: ${data.name} ${data.cols}x${data.rows}, tokens ${data.tokens.map((t) => `${t.id}@${t.r + 1}x${t.c + 1}`).join(" ")}`);
}
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) !== -1) {
    const chunk = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const ev = /^event: (.+)$/m.exec(chunk)?.[1];
    const data = /^data: (.+)$/m.exec(chunk)?.[1];
    if (ev && data && ev !== "state") await onEvent(ev, JSON.parse(data));
  }
}
log(`stream closed after ${dmCount} DM messages`);
