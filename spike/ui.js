import { App } from "@modelcontextprotocol/ext-apps";

const root = document.getElementById("app");
root.innerHTML = `<div class="card"><div class="title">D&amp;D Tabletop spike</div>
<canvas id="c" width="250" height="250"></canvas><div id="diag" class="diag">waiting for tool result...</div>
<button id="say" hidden>Say "I move to 3x2" in chat</button></div>`;

const app = new App({ name: "dnd-spike", version: "0.0.1" }, { availableDisplayModes: ["inline"] }, { autoResize: true });

function draw(view) {
  const c = document.getElementById("c");
  const dpr = window.devicePixelRatio || 1;
  const size = 50;
  c.width = view.cols * size * dpr;
  c.height = view.rows * size * dpr;
  c.style.width = view.cols * size + "px";
  c.style.height = view.rows * size + "px";
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  const colors = { "#": "#5b5e66", ".": "#2b2f36", "+": "#8a5a2b", "@": "#2b2f36", w: "#2b2f36" };
  g.textAlign = "center";
  g.textBaseline = "middle";
  view.cells.forEach((row, r) =>
    [...row].forEach((ch, col) => {
      g.fillStyle = colors[ch] ?? "#2b2f36";
      g.fillRect(col * size, r * size, size - 1, size - 1);
      if (ch === "@" || ch === "w") {
        g.fillStyle = ch === "@" ? "#3b82f6" : "#dc2626";
        g.beginPath();
        g.arc(col * size + size / 2, r * size + size / 2, size * 0.38, 0, Math.PI * 2);
        g.fill();
        g.font = "22px sans-serif";
        g.fillText(ch === "@" ? "🧙" : "🐺", col * size + size / 2, r * size + size / 2 + 1);
      }
    }),
  );
}

app.ontoolresult = (result) => {
  const view = result?._meta?.["dnd-tabletop/view"];
  const caps = app.getHostCapabilities() ?? {};
  const ctx = app.getHostContext() ?? {};
  const host = app.getHostVersion?.()?.name ?? "?";
  const diag = [
    `host: ${host}`,
    `_meta data: ${view ? "received" : "MISSING"}`,
    `structuredContent: ${result?.structuredContent ? "present" : "absent"}`,
    `ui/message: ${caps.message ? "yes" : "no"}`,
    `server tools: ${caps.serverTools ? "yes" : "no"}`,
    `display modes: ${(ctx.availableDisplayModes ?? []).join(",") || "?"}`,
    `server saw UI ext: ${view?.uiExt ? "yes" : "no"}`,
  ];
  document.getElementById("diag").textContent = diag.join(" · ");
  draw(view ?? { rows: 5, cols: 5, cells: ["#####", "#...#", "#.@.#", "#..w#", "##+##"] });
  const say = document.getElementById("say");
  say.hidden = false;
  say.onclick = () =>
    app
      .sendMessage({ role: "user", content: [{ type: "text", text: "I move to 3x2" }] })
      .then((r) => (say.textContent = r?.isError ? "message rejected by host" : "message sent"))
      .catch((e) => (say.textContent = "ui/message failed: " + (e?.message ?? e)));
};

app.connect().catch((e) => {
  document.getElementById("diag").textContent = "connect failed: " + e;
});
