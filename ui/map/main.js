// Claude Desktop map card: a stateless renderer of the server's map payload. It never moves
// tokens; clicks only offer an intent for the chat. The canvas lives in ui/shared/mapcanvas.js.
import { createApp, h, say, viewOf, watchSupersede } from "../shared/host.js";
import { mountMap, legendItems, scaleText, cellName, typeLabel } from "../shared/mapcanvas.js";
import { renderInitBar } from "../shared/initbar.js";

const INLINE_MAX = 460;
const S = { view: null, old: false, fullscreen: false };

// ---------- DOM ----------
const nameEl = h("span", { class: "name" }, "Map");
const metaEl = h("span", { class: "meta" });
const oldChip = h("span", { class: "chip old-chip", title: "A newer map card exists below" }, "older view");
const btn = (label, title, on) => h("button", { class: "tb", title, "aria-label": title, onclick: on }, label);
const expandBtn = btn("⛶", "Expand", () => toggleFullscreen());
expandBtn.hidden = true;
const header = h(
  "header",
  {},
  h("div", { class: "title" }, nameEl, metaEl, oldChip),
  h("div", { class: "tools" }, btn("−", "Zoom out", () => map.zoomBy(1 / 1.25)), btn("Fit", "Fit to card", () => map.fit()), btn("+", "Zoom in", () => map.zoomBy(1.25)), expandBtn),
);
const captionEl = h("div", { class: "caption" });
const emptyEl = h("div", { class: "empty" }, h("div", { class: "empty-icon" }, "🗺"), h("div", {}, "No map yet."), h("div", { class: "muted" }, "The DM hasn't set a scene."));
const initEl = h("div", { class: "initbar", hidden: true, "aria-label": "Turn order" });
const stage = h("div", { class: "stage" }, emptyEl);
const legendEl = h("div", { class: "legend" });
const intentInput = h("input", { class: "intent-text", type: "text", maxlength: "300", "aria-label": "What you want to do" });
const sendBtn = h("button", { class: "send" }, "Say it in chat");
const intentNote = h("div", { class: "intent-note" });
const intentEl = h(
  "div",
  { class: "intent", hidden: true },
  h("div", { class: "intent-row" }, intentInput, sendBtn, h("button", { class: "tb close", title: "Close", "aria-label": "Close", onclick: () => closeIntent() }, "✕")),
  intentNote,
);
const footer = h("footer", {}, legendEl, intentEl);
const card = h("div", { class: "card loading" }, header, captionEl, initEl, stage, footer);
document.getElementById("app").append(card);

const map = mountMap({ stage, sizing: "content", maxHeight: INLINE_MAX, onCell: (cell, t) => openIntent(cell, t) });

// ---------- intent ----------
function openIntent(cell, t) {
  const where = cellName(cell.r, cell.c);
  intentInput.value = t ? `${t.side === "player" ? "Me" : t.name || `The ${typeLabel(t.type)}`} at ${where}: ` : `I move to ${where}.`;
  intentNote.textContent = S.old ? "This is an older map. Use the newest card to act." : "";
  sendBtn.disabled = S.old;
  intentEl.hidden = false;
  intentInput.focus();
  intentInput.setSelectionRange(intentInput.value.length, intentInput.value.length);
}

function closeIntent() {
  intentEl.hidden = true;
  map.clearSelection();
}

async function sendIntent() {
  const text = intentInput.value.trim();
  if (!text || S.old) return;
  sendBtn.disabled = true;
  const ok = await say(app, text);
  sendBtn.disabled = false;
  if (ok) {
    intentNote.textContent = "Sent. Waiting for the DM…";
    setTimeout(closeIntent, 900);
  } else {
    intentNote.textContent = "Couldn't send from the card. Type it in the chat instead.";
    intentInput.select();
  }
}
sendBtn.addEventListener("click", sendIntent);
intentInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendIntent();
  if (e.key === "Escape") closeIntent();
});

// ---------- render a payload ----------
function render(v) {
  S.view = v;
  card.classList.remove("loading");
  renderInitBar(initEl, v);
  if (!v || v.empty) {
    card.classList.add("is-empty");
    nameEl.textContent = "Map";
    metaEl.textContent = "";
    captionEl.hidden = true;
    legendEl.replaceChildren();
    return;
  }
  card.classList.remove("is-empty");
  nameEl.textContent = v.name;
  metaEl.textContent = `${v.cols}×${v.rows} · 1 sq = ${scaleText(v)}`;
  captionEl.textContent = v.caption || "";
  captionEl.hidden = !v.caption;
  legendEl.replaceChildren(...legendItems(v));
  map.render(v);
  watchSupersede("dnd-tabletop-map", v.at, () => {
    S.old = true;
    card.classList.add("old");
    map.setAnimated(false);
    sendBtn.disabled = true;
  });
}

// ---------- host ----------
const app = createApp("dnd-map", ["inline", "fullscreen"]);

function applyContext(ctxt) {
  if (!ctxt) return;
  if (ctxt.availableDisplayModes) expandBtn.hidden = !ctxt.availableDisplayModes.includes("fullscreen");
  // Hosts resend context often (e.g. while scrolling); only a real mode change re-fits the map.
  if (ctxt.displayMode && (ctxt.displayMode === "fullscreen") !== S.fullscreen) {
    S.fullscreen = ctxt.displayMode === "fullscreen";
    document.documentElement.classList.toggle("fs", S.fullscreen);
    expandBtn.textContent = S.fullscreen ? "🗗" : "⛶";
    expandBtn.title = S.fullscreen ? "Back to chat size" : "Expand";
    // fullscreen: the stage fills the window and the wheel zooms; inline: content height, wheel scrolls the chat
    map.setWheel(S.fullscreen ? "always" : "modifier");
    if (S.fullscreen) {
      const used = header.offsetHeight + captionEl.offsetHeight + initEl.offsetHeight + footer.offsetHeight + 4;
      stage.style.height = `${Math.max(200, window.innerHeight - used)}px`;
      map.setSizing("fill");
    } else map.setSizing("content");
  }
}

async function toggleFullscreen() {
  try {
    const res = await app.requestDisplayMode({ mode: S.fullscreen ? "inline" : "fullscreen" });
    applyContext({ displayMode: res?.mode });
  } catch {
    expandBtn.hidden = true;
  }
}

addEventListener("resize", () => {
  if (!S.fullscreen) return;
  const used = header.offsetHeight + captionEl.offsetHeight + initEl.offsetHeight + footer.offsetHeight + 4;
  stage.style.height = `${Math.max(200, window.innerHeight - used)}px`;
  map.layout();
});

app.ontoolresult = (result) => render(viewOf(result));
app.onhostcontextchanged = (c) => applyContext(c);
app.onteardown = async () => ({});
app
  .connect()
  .then(() => applyContext(app.getHostContext()))
  .catch(() => {
    card.classList.remove("loading");
  });
