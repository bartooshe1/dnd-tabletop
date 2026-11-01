// Storybook: the whole campaign as one readable, self-contained HTML file. It is built only
// from player-facing text: the page's whitelisted notes sections and the transcripts (or the
// chat when there are none). Never DM Secrets, never enemy HP numbers.
import fs from "node:fs";
import path from "node:path";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function inline(text) {
  return esc(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\s][^*\n]*)\*/g, "<em>$1</em>")
    .replace(/(^|\W)_([^_\s][^_\n]*)_(?=\W|$)/g, "$1<em>$2</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

/** The same small markdown subset the game page uses, as escaped HTML. */
export function mdToHtml(text) {
  const out = [];
  for (const block of String(text).replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    if (lines.length === 1 && /^-{3,}$/.test(lines[0].trim())) {
      out.push("<hr>");
      continue;
    }
    if (lines.length === 1 && /^#{1,3} /.test(lines[0])) {
      out.push(`<h4>${inline(lines[0].replace(/^#{1,3} /, ""))}</h4>`);
      continue;
    }
    if (lines.every((l) => /^>\s?/.test(l))) {
      out.push(`<blockquote>${inline(lines.map((l) => l.replace(/^>\s?/, "")).join(" "))}</blockquote>`);
      continue;
    }
    let list = null;
    let para = [];
    const flush = () => {
      if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    };
    for (const l of lines) {
      const item = /^\s*(?:[-*•]|\d+[.)]) (.*)$/.exec(l);
      if (item) {
        flush();
        if (!list) out.push((list = []));
        list.push(`<li>${inline(item[1])}</li>`);
      } else {
        list = null;
        para.push(l);
      }
    }
    flush();
  }
  return out.map((x) => (Array.isArray(x) ? `<ul>${x.join("")}</ul>` : x)).join("\n");
}

/** Parse a transcript file: "**DM** (21:20:02): text" entries, each running to the next one. */
export function parseTranscript(text) {
  const entries = [];
  const re = /^\*\*([^*\n]{1,20})\*\* \((\d\d:\d\d:\d\d)\): /gm;
  let m;
  let last = null;
  while ((m = re.exec(text))) {
    if (last) last.text = text.slice(last.start, m.index).trim();
    last = { who: m[1], time: m[2], start: m.index + m[0].length };
    entries.push(last);
  }
  if (last) last.text = text.slice(last.start).trim();
  return entries.map(({ who, time, text: t }) => ({ who: who === "DM" ? "dm" : who === "Player" ? "player" : who.toLowerCase(), time, text: t }));
}

const dayOf = (id) => {
  const m = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)(\d\d)/.exec(id);
  if (!m) return id;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
};

const PIC = /\s*\[picture: (images\/[a-f0-9]{16}\.(?:jpg|png|gif|webp))\]/g;

function entryHtml(e, hero, picture) {
  if (e.who === "dm") return `<div class="dm">${mdToHtml(e.text)}</div>`;
  if (e.who === "player") {
    // pictures the player added: embedded, so the book stays one self-contained file
    const pics = [...e.text.matchAll(PIC)].map((m) => picture?.(m[1])).filter(Boolean);
    const text = e.text.replace(PIC, "").trim();
    const imgs = pics.length ? `<div class="pics">${pics.map((src) => `<img src="${esc(src)}" alt="">`).join("")}</div>` : "";
    return `<div class="me"><span class="who">${esc(hero)}</span>${inline(text).replace(/\n/g, "<br>")}${imgs}</div>`;
  }
  if (e.who === "roll") return `<div class="roll">🎲 ${inline(e.text)}</div>`;
  if (e.who === "scene") return `<div class="scene">${inline(e.text)}</div>`;
  return "";
}

/**
 * Build the storybook. `sections`: [{ name, body }] (already whitelisted); `chapters`:
 * [{ id, entries }]. Returns the HTML document.
 */
export function buildStorybook({ title, hero, sections, chapters, made = new Date(), picture = null, portrait = null }) {
  const notes = sections.filter((s) => s.body.trim());
  const toc = chapters.map((c, i) => `<li><a href="#ch${i + 1}">Chapter ${i + 1}</a> <span>${esc(dayOf(c.id))}</span></li>`).join("");
  const body = chapters
    .map((c, i) => `<section class="chapter" id="ch${i + 1}"><h2>Chapter ${i + 1}</h2><p class="date">${esc(dayOf(c.id))}</p>${c.entries.map((e) => entryHtml(e, hero, picture)).join("\n")}</section>`)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Storybook</title>
<style>
:root { --ink: #2b2118; --muted: #7a6a55; --gold: #9a6b16; --paper: #f6efdf; --line: #dccfb2; }
@media (prefers-color-scheme: dark) { :root { --ink: #e8e3d6; --muted: #a59c88; --gold: #d4a64a; --paper: #17181c; --line: #34312a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 17px/1.65 Georgia, "Iowan Old Style", "Palatino Linotype", serif; }
main { max-width: 720px; margin: 0 auto; padding: 48px 20px 80px; }
h1 { font-size: 40px; line-height: 1.15; margin: 0 0 6px; text-align: center; color: var(--gold); letter-spacing: .01em; }
.sub { text-align: center; color: var(--muted); font-style: italic; margin: 0 0 32px; }
h2 { font-size: 26px; color: var(--gold); margin: 56px 0 0; text-align: center; }
h3 { font-size: 15px; text-transform: uppercase; letter-spacing: .1em; color: var(--gold); border-bottom: 1px solid var(--line); padding-bottom: 4px; margin: 28px 0 8px; }
h4 { margin: 18px 0 6px; color: var(--gold); }
.date { text-align: center; color: var(--muted); font-style: italic; margin: 2px 0 24px; }
.toc { list-style: none; padding: 0; columns: 2; font-size: 15px; }
.toc span { color: var(--muted); }
a { color: var(--gold); }
.dm p { margin: 0 0 12px; }
.dm ul { margin: 0 0 12px; }
.me { margin: 6px 0 16px 28px; padding: 6px 12px; border-left: 3px solid var(--gold); font-style: italic; }
.me .who { font-style: normal; font-weight: 700; margin-right: 8px; color: var(--gold); }
.roll { font: 14px/1.4 system-ui, sans-serif; color: var(--muted); text-align: center; margin: 4px 0 12px; }
.scene { text-align: center; font-style: italic; color: var(--gold); margin: 28px 0 16px; }
.scene::before, .scene::after { content: " ✦ "; }
blockquote { margin: 0 0 12px; padding-left: 12px; border-left: 3px solid var(--line); font-style: italic; }
code { font-size: .9em; }
hr { border: 0; border-top: 1px solid var(--line); margin: 20px 0; }
.notes { font-size: 15.5px; }
.portrait { display: block; width: 140px; height: 140px; object-fit: cover; border-radius: 50%; margin: 0 auto 12px; border: 3px solid var(--gold); }
.pics { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; font-style: normal; }
.pics img { max-width: 100%; max-height: 360px; border-radius: 6px; border: 1px solid var(--line); }
@media print { body { background: #fff; color: #000; } .chapter { page-break-before: always; } }
</style></head>
<body><main>
<h1>${esc(title)}</h1>
${portrait ? `<img class="portrait" src="${esc(portrait)}" alt="${esc(hero)}">` : ""}
<p class="sub">The story of ${esc(hero)} · made ${esc(made.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }))}</p>
${chapters.length ? `<h3>Chapters</h3><ul class="toc">${toc}</ul>` : ""}
${notes.length ? `<div class="notes">${notes.map((s) => `<h3>${esc(s.name)}</h3>${mdToHtml(s.body)}`).join("\n")}</div>` : ""}
${body || `<p class="date">No story written yet.</p>`}
</main></body></html>
`;
}

/**
 * Read this campaign's transcripts (oldest first); empty sessions are skipped, and so is a
 * transcript whose heading names a different campaign.
 */
export function readChapters(dataDir, ids, title = null) {
  const dir = path.join(dataDir, "transcripts");
  const out = [];
  for (const id of ids) {
    const f = path.join(dir, `${id}.md`);
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, "utf8");
    const named = /^# Transcript \S+ · (.+)$/m.exec(text)?.[1]?.trim();
    if (title && named && named !== title) continue;
    const entries = parseTranscript(text);
    if (entries.length) out.push({ id, entries });
  }
  return out;
}
