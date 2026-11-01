// Claude Code mode game page: chat (top), dice strip (middle), map (bottom). A stateless view of
// the server's state: everything arrives over Server-Sent Events, with a full snapshot on every
// (re)connect, and the player's actions go back as POSTs. No external requests, no CDN.
import { h, reducedMotion } from "../shared/dom.js";
import { mountMap, legendItems, scaleText, cellName } from "../shared/mapcanvas.js";
import { rollRows } from "../shared/dicefx.js";
import { renderInitBar } from "../shared/initbar.js";
import { conditionInfo } from "../shared/conditions.js";
import { parseProgress, xpBar, openLevelUp } from "./levelup.js";
import { AMBIENTS, diceSound, setAmbient, setSoundOptions, turnChime } from "./sound.js";

const params = new URLSearchParams(location.search);
const store = {
  get(k, d) {
    try {
      return localStorage.getItem(`dnd-${k}`) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`dnd-${k}`, v);
    } catch {
      /* private window: fine, it just won't be remembered */
    }
  },
};
const TEXT_SIZES = [0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
// a link copied from a terminal can pick up spaces, line breaks or a trailing ")" or "."
const S = { token: (params.get("t") ?? "").replace(/[^\w-]/g, "") || null, connected: false, everConnected: false, settings: {}, state: {}, map: null, typing: null, rollsSeen: new Set(), lastChatId: 0 };

// ---------- markdown subset (built with DOM nodes, never innerHTML) ----------
function inline(text) {
  const out = [];
  const re = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_|`[^`\n]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**") || t.startsWith("__")) out.push(h("strong", {}, t.slice(2, -2)));
    else if (t.startsWith("`")) out.push(h("code", {}, t.slice(1, -1)));
    else out.push(h("em", {}, t.slice(1, -1)));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function markdown(text) {
  const frag = document.createDocumentFragment();
  for (const block of String(text).replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    if (lines.every((l) => /^\s*[-*•] /.test(l))) frag.append(h("ul", {}, lines.map((l) => h("li", {}, inline(l.replace(/^\s*[-*•] /, ""))))));
    else if (lines.every((l) => /^\s*\d+[.)] /.test(l))) frag.append(h("ol", {}, lines.map((l) => h("li", {}, inline(l.replace(/^\s*\d+[.)] /, ""))))));
    else if (lines.every((l) => /^>\s?/.test(l))) frag.append(h("blockquote", {}, inline(lines.map((l) => l.replace(/^>\s?/, "")).join(" "))));
    else if (/^#{1,3} /.test(lines[0]) && lines.length === 1) frag.append(h("p", { class: "md-h" }, inline(lines[0].replace(/^#{1,3} /, ""))));
    else {
      // mixed block: plain lines become a paragraph, runs of "- item" lines become a list
      let p = null;
      let ul = null;
      for (const l of lines) {
        if (/^\s*[-*•] /.test(l)) {
          p = null;
          if (!ul) frag.append((ul = h("ul")));
          ul.append(h("li", {}, inline(l.replace(/^\s*[-*•] /, ""))));
        } else {
          ul = null;
          if (!p) frag.append((p = h("p")));
          else p.append(h("br"));
          p.append(...inline(l));
        }
      }
    }
  }
  return frag;
}

// ---------- DOM ----------
const titleEl = h("span", { class: "title" }, "D&D Tabletop");
const statusEl = h("span", { class: "status", "aria-live": "polite" }, "connecting…");
const narrowHeader = () => matchMedia("(max-width: 600px)").matches;
const pauseBtn = h("button", { class: "btn", type: "button", disabled: true, title: "Save & pause", onclick: () => api("/api/pause") }, narrowHeader() ? "Save" : "Save & pause");
const sheetBtn = h("button", { class: "btn sheet-btn", type: "button", title: "Character sheet and journal", "aria-label": "Character sheet and journal", onclick: () => toggleSheet() }, narrowHeader() ? "📜" : "📜 Sheet");
const gearBtn = h("button", { class: "btn icon", type: "button", title: "Settings", "aria-label": "Settings", onclick: () => toggleSettings(true) }, "⚙");
const sizeBtns = h(
  "span",
  { class: "size-btns" },
  h("button", { class: "btn icon", type: "button", title: "Smaller text", "aria-label": "Smaller text", onclick: () => stepTextSize(-1) }, "A−"),
  h("button", { class: "btn icon", type: "button", title: "Bigger text", "aria-label": "Bigger text", onclick: () => stepTextSize(1) }, "A+"),
);
const header = h("header", {}, h("div", { class: "head-l" }, h("span", { class: "logo" }, "⚔"), titleEl), h("div", { class: "head-r" }, statusEl, sizeBtns, sheetBtn, pauseBtn, gearBtn));
const banner = h("div", { class: "banner", hidden: true });
const playerEl = h("div", { class: "player", hidden: true });

const log = h("div", { class: "log", role: "log", "aria-live": "polite", "aria-label": "Story" });
const pendingEl = h("div", { class: "pending", hidden: true });
const narrow = matchMedia("(max-width: 600px)").matches;
const input = h("textarea", { rows: "1", placeholder: narrow ? "What do you do?" : "What do you do?  (click the map to add a square like 4x8)", "aria-label": "Your action", maxlength: "2000" });
const sendBtn = h("button", { class: "btn send", type: "submit" }, "Send");
// one hidden file picker for every kind of picture; `pickFor` says what the next pick is for
const filePick = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
let pickFor = "chat";
const choosePictures = (kind) => {
  pickFor = kind;
  filePick.multiple = kind === "chat";
  filePick.value = "";
  filePick.click();
};
filePick.addEventListener("change", () => addPictures([...filePick.files], pickFor));
const attachBtn = h("button", { class: "btn icon attach", type: "button", title: "Add a picture for the DM (or paste / drop one)", "aria-label": "Add a picture", onclick: () => choosePictures("chat") }, "📎");
const composer = h("form", { class: "composer" }, attachBtn, input, sendBtn, filePick);
const chat = h("section", { class: "chat" }, log, pendingEl, composer);

const trayEl = h(
  "div",
  { class: "tray", "aria-label": "Dice tray: roll a die, it is added to your next message" },
  [4, 6, 8, 10, 12, 20, 100].map((s) => h("button", { class: `die-btn t${s}`, type: "button", title: `Roll 1d${s}`, onclick: () => api("/api/roll", { dice: `1d${s}` }) }, s === 100 ? "d%" : `d${s}`)),
);
const latestEl = h("div", { class: "latest" }, h("span", { class: "muted" }, "No rolls yet."));
const chipsEl = h("div", { class: "chips" });
const diceStrip = h("section", { class: "dice-strip" }, trayEl, latestEl, chipsEl);

const mapName = h("span", { class: "map-name" });
const mapMeta = h("span", { class: "map-meta" });
const mapTools = h(
  "div",
  { class: "map-tools" },
  h("button", { class: "btn icon", type: "button", title: "Zoom out", "aria-label": "Zoom out", onclick: () => mapApi.zoomBy(1 / 1.25) }, "−"),
  h("button", { class: "btn icon", type: "button", title: "Fit", onclick: () => mapApi.fit() }, "Fit"),
  h("button", { class: "btn icon", type: "button", title: "Zoom in", "aria-label": "Zoom in", onclick: () => mapApi.zoomBy(1.25) }, "+"),
);
const mapPicBtn = h("button", { class: "btn icon", type: "button", title: "Put a picture on this map (its background)", "aria-label": "Map picture", onclick: () => choosePictures("map") }, "🖼");
const mapPicClear = h(
  "button",
  { class: "btn icon", type: "button", title: "Remove the map picture", "aria-label": "Remove the map picture", hidden: true, onclick: () => confirm("Remove the picture from this map?") && api("/api/image/clear", { kind: "map" }) },
  "✕🖼",
);
mapTools.prepend(mapPicBtn, mapPicClear);
const emptyEl = h("div", { class: "empty" }, h("div", { class: "empty-icon" }, "🗺"), h("div", {}, "Waiting for the Dungeon Master..."));
const stage = h("div", { class: "stage" }, emptyEl);
const legendEl = h("div", { class: "legend" });
const initEl = h("div", { class: "initbar", hidden: true, "aria-label": "Turn order" });
const mapPane = h("section", { class: "map-pane" }, h("div", { class: "map-head" }, h("div", {}, mapName, mapMeta), mapTools), initEl, stage, legendEl);

const settingsBody = h("div", { class: "settings-body" });
const settings = h(
  "div",
  { class: "settings", hidden: true, role: "dialog", "aria-label": "Settings" },
  h("div", { class: "settings-card" }, h("div", { class: "settings-head" }, h("b", {}, "Settings"), h("button", { class: "btn icon", type: "button", "aria-label": "Close", onclick: () => toggleSettings(false) }, "✕")), settingsBody),
);
settings.addEventListener("click", (e) => e.target === settings && toggleSettings(false));

const sheetHead = h("div", { class: "sheet-head" });
const sheetBody = h("div", { class: "sheet-body" });
const sheetClose = h("button", { class: "btn icon sheet-close", type: "button", "aria-label": "Close sheet", onclick: () => toggleSheet(false) }, "✕");
const tabBtn = (id, label) => h("button", { class: "tab", type: "button", role: "tab", "data-tab": id, onclick: () => setTab(id) }, label);
const tabs = h("div", { class: "tabs", role: "tablist" }, tabBtn("sheet", "📜 Sheet"), tabBtn("journal", "📖 Journal"));
const aside = h("aside", { class: "sheet", "aria-label": "Character sheet and journal" }, h("div", { class: "sheet-top" }, tabs, sheetClose), sheetHead, sheetBody);
// drag handles: chat | rolls, rolls | map (heights), and the sheet's left edge (width)
const grip = (dir, label) => h("div", { class: `grip ${dir}`, role: "separator", tabindex: "0", "aria-orientation": dir === "col" ? "vertical" : "horizontal", "aria-label": label, title: `${label} (drag; double-click to reset)` });
const gripChat = grip("row", "Resize chat");
const gripDice = grip("row", "Resize rolls");
const gripSheet = grip("col", "Resize sheet");
const main = h("div", { class: "main" }, header, banner, playerEl, chat, gripChat, diceStrip, gripDice, mapPane);
document.getElementById("app").append(h("div", { class: "shell" }, main, gripSheet, aside), settings);

const mapApi = mountMap({ stage, sizing: "fill", wheel: "always", onCell: (cell) => insertCell(cell) });

// ---------- talking to the server ----------
async function api(path, body = {}) {
  if (!S.token) return showBanner("This page needs the link from Claude Code (it has a ?t= code).", "warn");
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-dnd-token": S.token }, body: JSON.stringify(body) });
    if (r.status === 403) showBanner("This link is from an earlier session. Open the newest link from Claude Code.", "warn");
    return r.ok ? r.json().catch(() => ({})) : null;
  } catch {
    showBanner("Can't reach the game. Is Claude Code still running?", "warn");
    return null;
  }
}

function showBanner(text, kind = "info") {
  banner.textContent = text;
  banner.className = `banner ${kind}`;
  banner.hidden = !text;
}

function connect() {
  S.es?.close();
  const es = new EventSource(S.token ? `/events?t=${encodeURIComponent(S.token)}` : "/events");
  S.es = es;
  es.addEventListener("snapshot", (e) => applySnapshot(JSON.parse(e.data)));
  es.addEventListener("chat", (e) => addMessage(JSON.parse(e.data), { live: true }));
  es.addEventListener("map", (e) => setMap(JSON.parse(e.data)));
  es.addEventListener("roll", (e) => addRoll(JSON.parse(e.data), { live: true }));
  es.addEventListener("state", (e) => setState(JSON.parse(e.data)));
  es.addEventListener("settings", (e) => setSettings(JSON.parse(e.data)));
  es.addEventListener("player", (e) => setPlayer(JSON.parse(e.data)));
  es.addEventListener("pending", (e) => setPending(JSON.parse(e.data)));
  es.addEventListener("images", (e) => setPendingImages(JSON.parse(e.data)));
  es.addEventListener("sheet", (e) => setSheet(JSON.parse(e.data)));
  es.onopen = () => {
    S.connected = true;
  };
  es.onerror = () => {
    S.connected = false;
    statusEl.textContent = "offline";
    statusEl.className = "status off";
    if (es.readyState === EventSource.CLOSED) {
      // a few quick retries first (switching phone mode restarts the server), then give up slowly
      S.fails = (S.fails ?? 0) + 1;
      if (S.fails >= 4) explainOffline();
      else showBanner(S.switching ? "Switching phone play…" : "Reconnecting…", "info");
      setTimeout(connect, S.fails < 4 ? 700 : 4000);
    } else showBanner(S.switching ? "Switching phone play…" : "Reconnecting…", "info");
  };
}

/** Why can't we connect? Ask the server (if it answers at all) whether our link is right. */
async function explainOffline() {
  let r = null;
  try {
    r = await fetch(`/hello?t=${encodeURIComponent(S.token ?? "")}`, { cache: "no-store" });
  } catch {
    return showBanner(
      S.everConnected
        ? "Lost the game. Is Claude Code still running on the computer? If you're on a phone, check it's on the same Wi-Fi."
        : "Can't reach the game. Is Claude Code still running on the computer, and is this device on the same Wi-Fi?",
      "warn",
    );
  }
  if (r.status === 403 || !(await r.json().catch(() => ({}))).ok) {
    return showBanner("This link's code doesn't match the game (it's old or was cut off when copied). On the game computer open ⚙ Settings and scan the QR code again, or use the newest link from Claude Code.", "warn");
  }
  showBanner("Reconnecting…", "info");
}

function applySnapshot(s) {
  if (s.token && s.token !== S.token) {
    // opened with an old or half-copied link on the game computer: show the real one in the address bar
    S.token = s.token;
    const url = new URL(location.href);
    url.searchParams.set("t", s.token);
    history.replaceState(null, "", url);
  }
  S.fails = 0;
  S.switching = false;
  S.everConnected = true;
  showBanner("");
  finishTyping();
  log.replaceChildren();
  S.lastChatId = 0;
  for (const m of s.chat) addMessage(m, { live: false });
  chipsEl.replaceChildren();
  S.rollsSeen.clear();
  for (const r of s.rolls) addRoll(r, { live: false });
  if (s.rolls.length) showLatest(s.rolls.at(-1), { animate: false });
  S.campaigns = s.campaigns ?? [];
  setSettings(s.settings);
  setState(s.state, { initial: true });
  setPlayer(s.player);
  S.pendingImages = s.images ?? [];
  setPending(s.pending ?? []);
  setSheet(s.sheet);
  setMap(s.map);
}

// ---------- chat ----------
function addMessage(m, { live }) {
  if (m.id && m.id <= S.lastChatId) return;
  S.lastChatId = m.id ?? S.lastChatId;
  let el;
  if (m.who === "dm") el = h("div", { class: "msg dm" }, markdown(m.text));
  else if (m.who === "player")
    el = h(
      "div",
      { class: "msg me" },
      h("div", { class: "bubble" }, m.text || null, m.images?.length ? h("div", { class: "thumbs" }, m.images.map((id) => thumb(id))) : null),
    );
  else if (m.who === "roll") el = h("div", { class: "msg roll" }, `🎲 ${m.text}`);
  else if (m.who === "scene") el = h("div", { class: "msg scene" }, h("span", {}, m.text));
  else el = h("div", { class: "msg system" }, m.text);
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.append(el);
  if (live && m.who === "dm" && S.settings.typewriter && !reducedMotion()) typewrite(el);
  if (atBottom || !live || m.who === "player") log.scrollTop = log.scrollHeight;
}

/** Reveal a DM message letter by letter; any click or key shows it all at once. */
function typewrite(el) {
  finishTyping();
  const nodes = [];
  const walk = (n) => n.childNodes.forEach((c) => (c.nodeType === 3 ? nodes.push({ node: c, full: c.textContent }) : walk(c)));
  walk(el);
  const total = nodes.reduce((s, n) => s + n.full.length, 0);
  for (const n of nodes) n.node.textContent = "";
  el.classList.add("typing");
  const start = performance.now();
  const job = { done: false };
  const show = (count) => {
    let left = count;
    for (const n of nodes) {
      const take = Math.max(0, Math.min(n.full.length, left));
      n.node.textContent = n.full.slice(0, take);
      left -= take;
    }
  };
  job.finish = () => {
    if (job.done) return;
    job.done = true;
    show(total);
    el.classList.remove("typing");
    S.typing = null;
    log.scrollTop = log.scrollHeight;
  };
  const step = (now) => {
    if (job.done) return;
    const count = Math.floor(((now - start) / 1000) * 90);
    show(count);
    log.scrollTop = log.scrollHeight;
    if (count >= total) job.finish();
    else requestAnimationFrame(step);
  };
  S.typing = job;
  requestAnimationFrame(step);
}
const finishTyping = () => S.typing?.finish();
log.addEventListener("click", finishTyping);
addEventListener("keydown", (e) => {
  if (S.typing && e.target !== input) finishTyping();
});

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text && !S.pendingImages.length) return;
  finishTyping();
  input.value = "";
  autosize();
  const ok = await api("/api/say", { text });
  if (!ok) input.value = text;
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    composer.requestSubmit();
  }
});
const autosize = () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(120, input.scrollHeight)}px`;
};
input.addEventListener("input", autosize);

function insertCell(cell) {
  const ref = cellName(cell.r, cell.c);
  const v = input.value;
  const at = input.selectionStart ?? v.length;
  const before = v.slice(0, at);
  const after = v.slice(input.selectionEnd ?? at);
  const pad = before && !/\s$/.test(before) ? " " : "";
  input.value = `${before}${pad}${ref}${after && !/^\s/.test(after) ? " " : ""}${after}`;
  const pos = (before + pad + ref).length;
  input.focus({ preventScroll: true });
  input.setSelectionRange(pos, pos);
  autosize();
}

// ---------- dice ----------
function rollKey(r) {
  return `${r.t}|${r.text?.join("|")}`;
}

function addRoll(r, { live }) {
  const key = rollKey(r);
  if (S.rollsSeen.has(key)) return;
  S.rollsSeen.add(key);
  const nat = r.rolls?.find((x) => x.nat)?.nat;
  const total = r.rolls?.length === 1 ? r.rolls[0].total : r.rolls?.map((x) => x.total).join("/");
  const label = r.label || r.rolls?.[0]?.label || r.rolls?.[0]?.expr || "roll";
  const chip = h("button", { class: `chip${nat === 20 ? " nat20" : nat === 1 ? " nat1" : ""}`, type: "button", title: `${r.roller ? `${r.roller}: ` : ""}${r.text.join(" · ")}`, onclick: () => showLatest(r, { animate: true }) }, `${r.roller ? `${r.roller} ` : ""}${label} ${total}`);
  chipsEl.prepend(chip);
  while (chipsEl.childElementCount > 20) chipsEl.lastChild.remove();
  if (live) {
    showLatest(r, { animate: true });
    diceSound(r.rolls?.reduce((n, x) => n + (x.groups?.reduce((m, g) => m + (g.rolls?.length ?? 1), 0) ?? 1), 0) ?? 1, nat ?? null);
  }
}

let rollGen = 0;
function showLatest(r, { animate }) {
  const gen = ++rollGen;
  if (!r.rolls) return;
  const who = r.roller ? h("span", { class: "who" }, r.roller) : null;
  const { el } = rollRows(r.rolls, { alive: () => gen === rollGen, compact: true, instant: !animate });
  latestEl.replaceChildren(h("div", { class: "latest-head" }, who, r.label ? h("span", { class: "muted" }, r.label) : null), el);
}

S.pendingRolls = [];
S.pendingImages = [];
function setPending(list) {
  S.pendingRolls = list;
  renderPending();
}
function setPendingImages(list) {
  S.pendingImages = list;
  renderPending();
}
const PIC_LABEL = { portrait: "portrait", map: "map picture" };
function renderPending() {
  const list = S.pendingRolls;
  const pics = S.pendingImages;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  pendingEl.hidden = !list.length && !pics.length;
  pendingEl.replaceChildren(
    h("span", { class: "muted" }, "Goes with your next message:"),
    ...list.map((t) => h("span", { class: "pchip" }, t.replace(/^\[rolled /, "🎲 ").replace(/\]$/, ""))),
    ...(list.length ? [h("button", { class: "btn icon small", type: "button", title: "Discard these rolls", "aria-label": "Discard these rolls", onclick: () => api("/api/roll/clear") }, "✕")] : []),
    ...pics.map((p) =>
      h(
        "span",
        { class: "pthumb" },
        thumb(p.id),
        PIC_LABEL[p.kind] ? h("span", { class: "pthumb-label" }, PIC_LABEL[p.kind]) : null,
        h("button", { class: "pthumb-x", type: "button", title: p.kind === "chat" ? "Don't send this picture" : "Don't show this to the DM (it stays set)", "aria-label": "Remove picture", onclick: () => api("/api/image/remove", { id: p.id }) }, "✕"),
      ),
    ),
  );
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// ---------- pictures ----------
const imgUrl = (id) => `/img/${id}${S.token ? `?t=${encodeURIComponent(S.token)}` : ""}`;

function thumb(id) {
  return h("img", { class: "thumb", src: imgUrl(id), alt: "picture", loading: "lazy", onclick: (e) => (e.stopPropagation(), openLightbox(id)) });
}

const lightbox = h("div", { class: "lightbox", hidden: true, role: "dialog", "aria-label": "Picture", onclick: () => (lightbox.hidden = true) });
document.body.append(lightbox);
function openLightbox(id) {
  lightbox.replaceChildren(h("img", { src: imgUrl(id), alt: "picture" }));
  lightbox.hidden = false;
}
addEventListener("keydown", (e) => e.key === "Escape" && (lightbox.hidden = true));

/** Longest side, by use: what Claude reads best, a crisp map, a small portrait. */
const MAX_SIDE = { chat: 1568, map: 2048, portrait: 512 };

/** Shrink a picture in the browser (also turns phone photos upright) and return base64. */
async function shrink(file, kind) {
  const max = MAX_SIDE[kind] ?? 1568;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error("not a picture this browser can open"));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
    // a small PNG (pixel art, a drawn map, transparency) is sent as it is
    if (scale === 1 && file.type === "image/png" && file.size < 1.5 * 1024 * 1024) return await toBase64(file);
    const c = h("canvas");
    c.width = w;
    c.height = hgt;
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, hgt);
    g.drawImage(img, 0, 0, w, hgt);
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.86));
    return await toBase64(blob);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBase64(blob) {
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => bad(r.error);
    r.readAsDataURL(blob);
  });
}

/** Add pictures from the file picker, a paste or a drop. kind: chat | portrait | map. */
async function addPictures(files, kind = "chat") {
  const pics = files.filter((f) => f.type.startsWith("image/")).slice(0, kind === "chat" ? 3 : 1);
  if (!pics.length) return;
  if (!S.token) return showBanner("This page needs the link from Claude Code (it has a ?t= code).", "warn");
  showBanner(pics.length > 1 ? `Adding ${pics.length} pictures…` : "Adding the picture…", "info");
  for (const f of pics) {
    let data;
    try {
      data = await shrink(f, kind);
    } catch (e) {
      return showBanner(`Couldn't read ${f.name || "that picture"}: ${e.message}`, "warn");
    }
    let r;
    try {
      r = await fetch("/api/image", { method: "POST", headers: { "content-type": "application/json", "x-dnd-token": S.token }, body: JSON.stringify({ data, kind }) });
    } catch {
      return showBanner("Can't reach the game. Is Claude Code still running?", "warn");
    }
    if (!r.ok) return showBanner(r.status === 413 ? "That picture is too big." : (await r.text().catch(() => "")) || "The game didn't take that picture.", "warn");
  }
  showBanner("");
  if (kind === "chat") input.focus({ preventScroll: true });
}

input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  addPictures(files, "chat");
});
chat.addEventListener("dragover", (e) => {
  if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) {
    e.preventDefault();
    chat.classList.add("dropping");
  }
});
chat.addEventListener("dragleave", (e) => e.target === chat && chat.classList.remove("dropping"));
chat.addEventListener("drop", (e) => {
  chat.classList.remove("dropping");
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  addPictures(files, "chat");
});

// ---------- map / player / state ----------
function setMap(v) {
  S.map = v;
  const empty = !v || !!v.empty;
  mapPane.classList.toggle("is-empty", empty);
  if (empty) {
    renderInitBar(initEl, null);
    mapName.textContent = "";
    mapMeta.textContent = "";
    legendEl.replaceChildren();
    return;
  }
  renderInitBar(initEl, v);
  if (S.sound.ambient === "auto") setAmbient("auto", `${v.name} ${v.caption ?? ""}`);
  mapName.textContent = v.name;
  mapMeta.textContent = ` · ${v.cols}×${v.rows} · 1 sq = ${scaleText(v)}`;
  legendEl.replaceChildren(...legendItems(v));
  mapPicClear.hidden = !v.bg;
  mapApi.render({ ...v, bgUrl: v.bg ? imgUrl(v.bg) : null, tokens: v.tokens.map((t) => (t.portrait ? { ...t, portraitUrl: imgUrl(t.portrait) } : t)) });
}

// ---------- character sheet and journal ----------
S.sheet = { sections: [], journal: [] };
S.player = null;
S.tab = store.get("tab", "sheet") === "journal" ? "journal" : "sheet";

const JOURNAL_LABEL = { npcs: "People you've met", world_notes: "Places & lore", story_log: "Story so far" };
const JOURNAL_EMPTY = {
  quests: "No quests yet.",
  npcs: "Nobody met yet.",
  world_notes: "Places and lore you learn show up here.",
  story_log: "The story so far will be written here.",
};

function setTab(id) {
  S.tab = id;
  store.set("tab", id);
  renderSheet();
  sheetBody.scrollTop = 0;
}

function setSheet(sheet) {
  if (sheet) S.sheet = sheet;
  renderSheet();
}

function renderSheet() {
  renderPlayerStrip();
  for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.tab === S.tab));
  sheetHead.hidden = S.tab !== "sheet";
  if (S.tab === "journal") {
    sheetBody.replaceChildren(
      ...(S.sheet.journal ?? []).map((sec) => {
        const key = sec.name.toLowerCase().replace(/\s+/g, "_");
        return h("section", { class: `sheet-sec j-${key}` }, h("h3", {}, JOURNAL_LABEL[key] ?? sec.name), sec.body ? highlightSheet(h("div", { class: "md" }, markdown(sec.body))) : h("p", { class: "muted" }, JOURNAL_EMPTY[key] ?? "Nothing yet."));
      }),
    );
    return;
  }
  const p = S.player;
  const hasHp = p && typeof p.hp === "number";
  const pct = hasHp && p.maxHp ? Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100)) : 0;
  const face = p?.portrait
    ? h("button", { class: "portrait", type: "button", title: "Change your character's picture", onclick: () => choosePictures("portrait") }, h("img", { src: imgUrl(p.portrait), alt: "" }))
    : h("button", { class: "portrait empty", type: "button", title: "Add a picture of your character", onclick: () => choosePictures("portrait") }, "📷");
  const faceRemove = p?.portrait ? h("button", { class: "btn small", type: "button", onclick: () => confirm("Remove your character's picture?") && api("/api/image/clear", { kind: "portrait" }) }, "Remove picture") : null;
  sheetHead.replaceChildren(...[
    h("div", { class: "sheet-who" }, face, h("div", {}, h("div", { class: "sheet-name" }, p?.name || "Your character"), faceRemove)),
    hasHp
      ? h("div", { class: "sheet-hp" }, h("span", { class: "hp-bar big" }, h("span", { class: `hp-fill${pct <= 25 ? " low" : ""}`, style: `width:${pct}%` })), h("b", {}, `${p.hp}/${p.maxHp ?? "?"}`), " HP")
      : null,
    p?.status?.length ? h("div", { class: "sheet-conds" }, p.status.map((s) => condChip(s))) : null,
    xpBar(progress(), openGuide),
  ].filter(Boolean));
  sheetBody.replaceChildren(
    ...S.sheet.sections.map((sec) =>
      h("section", { class: "sheet-sec" }, h("h3", {}, sec.name), sec.body ? highlightSheet(h("div", { class: "md" }, markdown(sec.body))) : h("p", { class: "muted" }, "The DM fills this in as you play.")),
    ),
  );
}

const STAT = /(STR|DEX|CON|INT|WIS|CHA|AC|HP|XP|DC|Prof(?:iciency)?(?: bonus)?|Speed|Initiative|Level|Hit dice|Spell slots|Spell save DC|Spell attack|Saves|Saving throws|Skills|Passive Perception|Languages|Proficiencies|Money)/;
const LABEL = /^([A-Za-z][A-Za-z' /()&+-]{0,30}?):(?=\s|$)/;

/** Make a character sheet scannable: "Label:" in gold, stat names bold, lone lines as subheadings. */
function highlightSheet(root) {
  for (const p of root.querySelectorAll("p")) {
    const only = p.childNodes.length === 1 ? p.firstChild : null;
    const text = p.textContent.trim();
    if ((only && only.nodeName === "STRONG") || (/:$/.test(text) && text.length <= 32 && !p.querySelector("br"))) p.classList.add("sub");
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement.closest(".sub, .k, .stat")) continue;
    const lineStart = !node.previousSibling || node.previousSibling.nodeName === "BR";
    // split on " · ", " | " and "; " so every segment can start with its own label
    const parts = node.textContent.split(/(\s*[·|;]\s*)/);
    const out = [];
    parts.forEach((part, i) => {
      if (i % 2 === 1) return out.push(part);
      let rest = part;
      const segStart = i > 0 || lineStart;
      const lead = segStart ? LABEL.exec(rest.replace(/^\s+/, "")) : null;
      if (lead) {
        const ws = rest.match(/^\s*/)[0];
        out.push(ws, h("span", { class: "k" }, `${lead[1]}:`));
        rest = rest.slice(ws.length + lead[0].length);
      }
      let m;
      while ((m = STAT.exec(rest))) {
        out.push(rest.slice(0, m.index), h("span", { class: "stat" }, m[0]));
        rest = rest.slice(m.index + m[0].length);
      }
      out.push(rest);
    });
    if (out.some((x) => typeof x !== "string")) node.replaceWith(...out.filter((x) => x !== ""));
  }
  return root;
}

/** A condition chip that explains itself on hover, focus or tap. */
function condChip(name) {
  const info = conditionInfo(name);
  return h("span", { class: `cond${info ? " has-tip" : ""}`, tabindex: info ? "0" : null, "data-tip": info ? `${info.name[0].toUpperCase()}${info.name.slice(1)}\n${info.lines.map((l) => `• ${l}`).join("\n")}` : null }, name);
}

const popTip = h("div", { class: "poptip", role: "tooltip", hidden: true });
document.body.append(popTip);
let tipFor = null;
function showPopTip(el) {
  tipFor = el;
  const [head, ...lines] = el.dataset.tip.split("\n");
  popTip.replaceChildren(h("b", {}, head), ...lines.map((l) => h("div", {}, l)));
  popTip.hidden = false;
  const r = el.getBoundingClientRect();
  const w = popTip.offsetWidth;
  const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  const below = r.bottom + 8 + popTip.offsetHeight < innerHeight;
  popTip.style.left = `${x}px`;
  popTip.style.top = `${below ? r.bottom + 6 : r.top - popTip.offsetHeight - 6}px`;
}
const hidePopTip = () => {
  tipFor = null;
  popTip.hidden = true;
};
document.addEventListener("pointerover", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (el && e.pointerType !== "touch") showPopTip(el);
  else if (!el && tipFor && e.pointerType !== "touch") hidePopTip();
});
document.addEventListener("click", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (el && tipFor !== el) showPopTip(el);
  else if (tipFor) hidePopTip();
});
document.addEventListener("focusin", (e) => e.target.dataset?.tip && showPopTip(e.target));
document.addEventListener("focusout", (e) => e.target === tipFor && hidePopTip());
document.addEventListener("scroll", hidePopTip, true);

// ---------- XP and level up ----------
function progress() {
  const ch = S.sheet.sections.find((x) => x.name === "Character");
  return parseProgress(ch?.body);
}
function openGuide() {
  const p = progress();
  if (!p?.canLevel) return;
  toggleSheet(false);
  openLevelUp(p, {
    roll: (dice) => api("/api/roll", { dice }),
    send: async (text) => !!(await api("/api/say", { text })),
  });
}

function toggleSheet(open) {
  const on = open ?? !document.body.classList.contains("sheet-open");
  document.body.classList.toggle("sheet-open", on);
}

function setPlayer(p) {
  S.player = p;
  renderSheet();
}

function renderPlayerStrip() {
  const p = S.player;
  playerEl.hidden = !p;
  if (!p) return;
  const hasHp = typeof p.hp === "number";
  const pct = hasHp && p.maxHp ? Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100)) : 0;
  const prog = progress();
  playerEl.replaceChildren(
    p.portrait ? h("img", { class: "pface", src: imgUrl(p.portrait), alt: "" }) : null,
    h("span", { class: "pname" }, p.name || "You"),
    hasHp
      ? h("span", { class: "hp", title: "Hit points" }, h("span", { class: "hp-bar" }, h("span", { class: `hp-fill${pct <= 25 ? " low" : ""}`, style: `width:${pct}%` })), `${p.hp}/${p.maxHp ?? "?"} HP`)
      : null,
    ...(p.status ?? []).map((s) => condChip(s)),
    prog?.canLevel ? h("button", { class: "btn small levelup", type: "button", onclick: openGuide }, `⬆ Level ${prog.level + 1}!`) : null,
  );
}

function setState(st, { initial = false } = {}) {
  const wasTurn = S.state?.waiting && S.state?.status === "active";
  S.state = st;
  const isTurn = st.waiting && st.status === "active";
  if (isTurn && !wasTurn && !initial) yourTurn();
  titleEl.textContent = st.title || "D&D Tabletop";
  S.baseTitle = st.title ? `${st.title} · D&D` : "D&D Tabletop";
  document.title = S.flashing ? `● Your turn · ${S.baseTitle}` : S.baseTitle;
  pauseBtn.disabled = st.status !== "active" || st.pauseRequested;
  const label =
    st.status === "paused" ? "saved" : st.status === "idle-stop" ? "DM paused" : st.status !== "active" ? "waiting for the DM" : st.pauseRequested ? "saving…" : st.waiting ? "your turn" : "DM is thinking…";
  statusEl.textContent = label;
  statusEl.className = `status ${st.waiting && st.status === "active" ? "turn" : st.status === "active" ? "busy" : "idle"}`;
  if (st.status === "idle-stop") showBanner("DM paused. Run /continuednd in Claude Code to play on.", "warn");
  else if (st.status === "paused") showBanner("Saved. Run /continuednd in Claude Code to play on.", "ok");
  else if (banner.classList.contains("ok") || banner.textContent.startsWith("DM paused")) showBanner("");
}

// ---------- your turn: sound, notification, tab title ----------
S.notify = store.get("notify", "0") === "1";
function yourTurn() {
  turnChime();
  if (!document.hidden) return;
  S.flashing = true;
  document.title = `● Your turn · ${S.baseTitle}`;
  if (!S.notify || typeof Notification !== "function" || Notification.permission !== "granted") return;
  const last = [...log.querySelectorAll(".msg.dm")].at(-1)?.textContent ?? "";
  try {
    const n = new Notification("Your turn", { body: last.slice(0, 140) || "The DM is waiting for you.", tag: "dnd-turn" });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some phones only allow notifications from installed apps; the tab title still flashes */
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !S.flashing) return;
  S.flashing = false;
  document.title = S.baseTitle;
});

async function setNotify(on) {
  if (on && typeof Notification === "function" && Notification.permission === "default") await Notification.requestPermission().catch(() => {});
  S.notify = on && typeof Notification === "function" && Notification.permission === "granted";
  store.set("notify", S.notify ? "1" : "0");
  renderSettings();
}

// ---------- sound (this device only) ----------
S.sound = { fx: store.get("sound-fx", "0") === "1", ambient: AMBIENTS[store.get("sound-ambient", "off")] ? store.get("sound-ambient", "off") : "off", volume: Math.max(0, Math.min(1, Number(store.get("sound-volume", "0.6")) || 0.6)) };
setSoundOptions(S.sound);
const sceneText = () => (S.map && !S.map.empty ? `${S.map.name} ${S.map.caption ?? ""}` : "");
setAmbient(S.sound.ambient, sceneText());
function setSound(patch) {
  Object.assign(S.sound, patch);
  store.set("sound-fx", S.sound.fx ? "1" : "0");
  store.set("sound-ambient", S.sound.ambient);
  store.set("sound-volume", String(S.sound.volume));
  setSoundOptions(S.sound);
  if ("ambient" in patch) setAmbient(S.sound.ambient, sceneText());
}

// ---------- storybook ----------
async function downloadStorybook(btn, note) {
  btn.disabled = true;
  btn.textContent = "Writing the storybook…";
  const r = await api("/api/storybook");
  btn.disabled = false;
  btn.textContent = "📖 Download the storybook";
  if (!r?.html) return (note.textContent = "Couldn't make the storybook.");
  const url = URL.createObjectURL(new Blob([r.html], { type: "text/html" }));
  const a = h("a", { href: url, download: r.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  note.textContent = `Saved. A copy is also in ${r.file}`;
}

// ---------- a new secret link ----------
async function newLink() {
  if (!confirm("Make a new link? The old link (and phone bookmarks) stop working.")) return;
  const r = await api("/api/link/new");
  if (!r?.token) return;
  S.token = r.token;
  const url = new URL(location.href);
  url.searchParams.set("t", r.token);
  history.replaceState(null, "", url);
  setSettings(r.settings);
  connect();
}

// ---------- settings ----------
function setSettings(s) {
  S.settings = { ...S.settings, ...s };
  if (!settings.hidden) renderSettings();
}

// text size for the chat and the side panel: remembered by this browser only
S.textSize = TEXT_SIZES.includes(Number(store.get("text-size", "1"))) ? Number(store.get("text-size", "1")) : 1;
function setTextSize(v) {
  S.textSize = v;
  store.set("text-size", String(v));
  document.documentElement.style.setProperty("--text-scale", String(v));
  log.scrollTop = log.scrollHeight;
}
setTextSize(S.textSize);
function stepTextSize(dir) {
  const i = TEXT_SIZES.indexOf(S.textSize);
  const next = TEXT_SIZES[Math.max(0, Math.min(TEXT_SIZES.length - 1, i + dir))];
  setTextSize(next);
  return next;
}

function toggleSettings(open) {
  settings.hidden = !open;
  if (open) renderSettings();
}

function renderSettings() {
  const s = S.settings;
  const toggle = (key, label, hint) =>
    h(
      "label",
      { class: "row" },
      h("input", {
        type: "checkbox",
        checked: !!s[key],
        onchange: (e) => {
          // remember the choice right away: switching phone play restarts the server, and the reply can get lost
          S.settings = { ...S.settings, [key]: e.target.checked };
          if (key === "lan") S.switching = true;
          api("/api/settings", { [key]: e.target.checked }).then((r) => r && setSettings(r));
        },
      }),
      h("span", {}, h("b", {}, label), hint ? h("span", { class: "muted" }, ` ${hint}`) : null),
    );
  const units = h(
    "div",
    { class: "row" },
    h("b", {}, "Units "),
    ["metric", "imperial"].map((u) =>
      h("label", { class: "radio" }, h("input", { type: "radio", name: "units", checked: s.units === u, onchange: () => api("/api/settings", { units: u }).then((r) => r && setSettings(r)) }), u === "metric" ? "meters" : "feet"),
    ),
  );
  const lan = [toggle("lan", "Play from a phone (LAN)", "Lets devices on your Wi-Fi open the game.")];
  if (s.lan) {
    lan.push(h("p", { class: "warn-text" }, "Anyone on your network who has this link can play, and the connection is not encrypted. Use it on a home network only. Away from home, connect your phone with Tailscale instead."));
    lan.push(h("p", { class: "muted" }, "This link stays the same every time you play, so bookmark it on your phone (or add it to the home screen)."));
    if (s.lanWsl) {
      lan.push(
        h(
          "p",
          { class: "warn-text" },
          s.lanKinds?.includes("tailscale")
            ? "The game runs in WSL, so phones on your Wi-Fi can't reach it directly. The QR code uses your Tailscale address instead: open the Tailscale app on your phone (same account) and it works from anywhere."
            : "The game runs in WSL, so phones on your Wi-Fi can't reach it. Turn on WSL's mirrored networking (see the README), install Tailscale on this computer and your phone, or play from Claude Code on Windows instead.",
        ),
      );
    }
    const KIND = { tailscale: "Tailscale: phone needs the Tailscale app", private: "this computer only" };
    (s.lanUrls ?? []).forEach((u, i) => lan.push(h("div", { class: "lan-url" }, h("code", {}, u), KIND[s.lanKinds?.[i]] ? h("span", { class: "muted" }, ` (${KIND[s.lanKinds[i]]})`) : null)));
    if (s.lanQr) lan.push(h("img", { class: "qr", alt: "QR code for the LAN link", src: `data:image/svg+xml;base64,${btoa(s.lanQr)}` }));
    if (!(s.lanUrls ?? []).length) lan.push(h("p", { class: "muted" }, "No network address found. Is this computer on Wi-Fi?"));
    if (s.lanName) {
      lan.push(
        h("p", { class: "muted" }, "If your router gives this computer a new address, this name link keeps working on most iPhones, Macs and newer Androids:"),
        h("div", { class: "lan-url" }, h("code", {}, s.lanName)),
      );
    }
    lan.push(
      h("div", { class: "row" }, h("button", { class: "btn small", type: "button", onclick: () => newLink() }, "Make a new link"), h("span", { class: "muted" }, "Only if someone else got your link: every phone then needs the new one.")),
    );
  }
  const pct = h("span", { class: "size-pct" }, `${Math.round(S.textSize * 100)}%`);
  const size = h(
    "div",
    { class: "row" },
    h("b", {}, "Text size "),
    h("button", { class: "btn icon", type: "button", "aria-label": "Smaller text", onclick: () => (pct.textContent = `${Math.round(stepTextSize(-1) * 100)}%`) }, "A−"),
    pct,
    h("button", { class: "btn icon", type: "button", "aria-label": "Bigger text", onclick: () => (pct.textContent = `${Math.round(stepTextSize(1) * 100)}%`) }, "A+"),
    h("span", { class: "muted" }, "Chat and sheet, this device only."),
  );
  const layoutRow = h(
    "div",
    { class: "row" },
    h("b", {}, "Window sizes "),
    h("button", { class: "btn small", type: "button", onclick: () => resetLayout() }, "Reset"),
    h("span", { class: "muted" }, "Drag the bars between chat, rolls, map and sheet."),
  );
  const check = (checked, label, hint, onchange) =>
    h("label", { class: "row" }, h("input", { type: "checkbox", checked, onchange: (e) => onchange(e.target.checked) }), h("span", {}, h("b", {}, label), hint ? h("span", { class: "muted" }, ` ${hint}`) : null));
  const canNotify = typeof Notification === "function" && window.isSecureContext;
  const sound = [
    h("div", { class: "set-head" }, "Sound"),
    check(S.sound.fx, "Sound effects", "Dice rolling and a chime when it's your turn.", (v) => setSound({ fx: v })),
    h(
      "label",
      { class: "row" },
      h("b", {}, "Background "),
      h("select", { class: "lu-sel", onchange: (e) => setSound({ ambient: e.target.value }) }, Object.entries(AMBIENTS).map(([k, v]) => h("option", { value: k, selected: S.sound.ambient === k }, v))),
    ),
    h("label", { class: "row" }, h("b", {}, "Volume "), h("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(S.sound.volume), oninput: (e) => setSound({ volume: Number(e.target.value) }) })),
    check(S.notify, "Tell me when it's my turn", canNotify ? "A notification when this tab is in the background." : "The tab title flashes. (Pop-up notifications need the link on this computer.)", (v) => setNotify(v)),
  ];
  if (!canNotify) sound.pop();
  const storyNote = h("p", { class: "muted" });
  const storyBtn = h("button", { class: "btn", type: "button", onclick: () => downloadStorybook(storyBtn, storyNote) }, "📖 Download the storybook");
  const story = [h("div", { class: "set-head" }, "Storybook"), h("p", { class: "muted" }, "Your whole adventure as one book you can read, print or share: every chapter, plus quests, people and places. No DM secrets."), storyBtn, storyNote];
  const camps = [h("div", { class: "set-head" }, "Campaigns")];
  if (S.campaigns?.length) {
    camps.push(h("p", { class: "muted" }, "Your other saved adventures. To play one, type the command in Claude Code (this one is saved first):"));
    for (const c of S.campaigns) {
      const cmd = `/continuednd ${c.title}`;
      camps.push(
        h(
          "div",
          { class: "camp" },
          h("span", {}, c.title, h("span", { class: "muted" }, ` · ${c.kind === "archive" ? "archived" : "saved"}${c.at ? ` ${new Date(c.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ""}`)),
          h("button", { class: "btn small", type: "button", onclick: (e) => navigator.clipboard?.writeText(cmd).then(() => (e.target.textContent = "Copied")).catch(() => (e.target.textContent = cmd)) }, "Copy command"),
        ),
      );
    }
  } else camps.push(h("p", { class: "muted" }, "Only this campaign so far. /startdnd starts another one; this one is kept and you can come back with /continuednd and its name."));
  settingsBody.replaceChildren(
    size,
    layoutRow,
    toggle("typewriter", "Typewriter effect", "Click the story to skip."),
    toggle("transcripts", "Save a transcript", "Full story text in the transcripts/ folder (the storybook is made from it)."),
    units,
    h("hr"),
    ...sound,
    h("hr"),
    ...story,
    h("hr"),
    ...camps,
    h("hr"),
    ...lan,
  );
}

// ---------- window sizes (remembered by this browser only) ----------
const MIN = { chat: 140, dice: 56, map: 150, sheet: 240 };
const readSize = (k) => {
  const n = Number(store.get(`size-${k}`, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
S.sizes = { chat: readSize("chat"), dice: readSize("dice"), sheet: readSize("sheet") };

/** Room the chat, rolls and map share: the main column minus header, banners and handles. */
function freeHeight() {
  const fixed = [header, banner, playerEl, gripChat, gripDice].reduce((sum, el) => sum + (el.hidden ? 0 : el.offsetHeight), 0);
  return main.clientHeight - fixed;
}

function applyLayout() {
  const z = S.sizes;
  const free = freeHeight();
  let dice = z.dice;
  if (dice != null) dice = Math.max(MIN.dice, Math.min(dice, free - MIN.chat - MIN.map));
  const diceH = dice ?? diceStrip.offsetHeight;
  let chatH = z.chat;
  if (chatH != null) chatH = Math.max(MIN.chat, Math.min(chatH, free - diceH - MIN.map));
  diceStrip.classList.toggle("sized", dice != null);
  diceStrip.style.height = dice != null ? `${dice}px` : "";
  chat.classList.toggle("sized", chatH != null);
  chat.style.height = chatH != null ? `${chatH}px` : "";
  const wide = !matchMedia("(max-width: 1000px)").matches;
  const sheetW = z.sheet != null && wide ? Math.max(MIN.sheet, Math.min(z.sheet, Math.round(innerWidth * 0.6))) : null;
  aside.style.width = sheetW != null ? `${sheetW}px` : "";
}

function saveSize(k, v) {
  S.sizes[k] = v;
  store.set(`size-${k}`, v == null ? "" : String(Math.round(v)));
  applyLayout();
}

function resetLayout() {
  for (const k of ["chat", "dice", "sheet"]) saveSize(k, null);
}

/** Drag (mouse, pen or touch) or arrow keys on a handle; double-click resets that one. */
function makeGrip(el, key, { read, dirSign = 1, axis = "y" }) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const start = axis === "y" ? e.clientY : e.clientX;
    const from = read();
    el.classList.add("dragging");
    document.body.classList.add(axis === "y" ? "resizing-y" : "resizing-x");
    const move = (ev) => saveSize(key, from + ((axis === "y" ? ev.clientY : ev.clientX) - start) * dirSign);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.classList.remove("dragging");
      document.body.classList.remove("resizing-y", "resizing-x");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up, { once: true });
    el.addEventListener("pointercancel", up, { once: true });
  });
  el.addEventListener("dblclick", () => saveSize(key, null));
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 60 : 20;
    const keys = axis === "y" ? { ArrowUp: -1, ArrowDown: 1 } : { ArrowLeft: -1, ArrowRight: 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    saveSize(key, read() + keys[e.key] * step * dirSign);
  });
}
makeGrip(gripChat, "chat", { read: () => chat.offsetHeight });
makeGrip(gripDice, "dice", { read: () => diceStrip.offsetHeight });
makeGrip(gripSheet, "sheet", { read: () => aside.offsetWidth, axis: "x", dirSign: -1 });
addEventListener("resize", applyLayout);
applyLayout();

addEventListener("keydown", (e) => e.key === "Escape" && toggleSettings(false));
connect();
