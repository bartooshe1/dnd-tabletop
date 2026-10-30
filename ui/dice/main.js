// Dice card: tumbles each die ~1.3s, then settles on the server's value (always the real one).
// Secret rolls render nothing at all.
import { createApp, h, say, viewOf } from "../shared/host.js";
import { rollRows } from "../shared/dicefx.js";

const app = createApp("dnd-dice");
const root = h("div", { class: "card", hidden: true });
document.getElementById("app").append(root);
let rollToken = 0;
let canTray = false;

function headline(v) {
  const who = v.roller ? (v.roller.toLowerCase() === "player" ? "You" : v.roller) : null;
  const mode = v.mode === "adv" ? "advantage" : v.mode === "dis" ? "disadvantage" : null;
  const parts = [v.label, mode].filter(Boolean);
  const verb = who === "You" ? "roll" : who ? "rolls" : "Roll";
  return h("div", { class: "head" }, who ? h("span", { class: "who" }, who) : null, h("span", { class: "what" }, parts.join(" · ") || verb));
}

function render(v, { fromTray = false } = {}) {
  const token = ++rollToken;
  if (!v || v.secret) {
    root.hidden = true;
    document.body.classList.add("secret");
    return;
  }
  document.body.classList.remove("secret");
  root.hidden = false;
  if (v.error) {
    root.replaceChildren(h("div", { class: "err" }, `Couldn't roll: ${v.error}`), tray());
    return;
  }
  const summary = v.rolls.map((r) => `${r.label ? `${r.label} ` : ""}${r.expr}: ${r.total}`);
  const { el: rowsEl } = rollRows(v.rolls, { alive: () => token === rollToken });
  const children = [headline(v), rowsEl];
  if (v.history?.length) {
    children.push(
      h(
        "details",
        { class: "hist" },
        h("summary", {}, "Earlier rolls"),
        v.history.slice(0, 5).map((e) => h("div", {}, `${e.roller ? `${e.roller}: ` : ""}${e.text.join(" · ")}`)),
      ),
    );
  }
  if (fromTray) {
    const msg = `I rolled ${summary.join(", ")}.`;
    const note = h("span", { class: "note" });
    const b = h("button", { class: "say", onclick: async () => {
      b.disabled = true;
      const ok = await say(app, msg);
      note.textContent = ok ? "Sent." : "Couldn't send. Type it in the chat.";
      if (!ok) b.disabled = false;
    } }, "Say it in chat");
    children.push(h("div", { class: "sayrow" }, b, note));
  }
  children.push(tray());
  root.replaceChildren(...children);
}

function tray() {
  if (!canTray) return null;
  const buttons = [4, 6, 8, 10, 12, 20, 100].map((s) =>
    h("button", { class: `tray-die t${s}`, title: `Roll 1d${s}`, onclick: () => trayRoll(s) }, s === 100 ? "d%" : `d${s}`),
  );
  return h("div", { class: "tray", "aria-label": "Roll a die yourself" }, h("span", { class: "muted" }, "Roll yourself:"), buttons);
}

async function trayRoll(sides) {
  try {
    const res = await app.callServerTool({ name: "roll", arguments: { dice: `1d${sides}`, roller: "player" } });
    const v = viewOf(res);
    if (v) render(v, { fromTray: true });
  } catch {
    canTray = false;
    root.querySelector(".tray")?.remove();
  }
}

app.ontoolinput = (p) => {
  if (p?.arguments?.secret) render({ secret: true });
};
app.ontoolresult = (result) => render(viewOf(result));
app.onteardown = async () => ({});
app
  .connect()
  .then(() => {
    canTray = !!app.getHostCapabilities()?.serverTools;
    const t = root.querySelector(".tray");
    if (!t && canTray && !root.hidden && root.childElementCount) root.append(tray());
  })
  .catch(() => {});
