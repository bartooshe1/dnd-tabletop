// campaign.md and house_rules.md: plain markdown files the player can open and edit.
// Sections are "## Heading" blocks; read/write/append work per section, or many at once.
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./store.js";
import { fuzzyPick, slug } from "./fuzzy.js";
import { TEMPLATE_DIR } from "./paths.js";

export const FILES = { campaign: "campaign.md", rules: "house_rules.md" };
export const CC_SECTION = "Claude Code mode";
export const DM_SECRETS = "DM Secrets";

export class NotesError extends Error {}

/** Split markdown into { pre, sections: [{ name, body }] } on "## " headings. */
export function splitSections(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const pre = [];
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      cur = { name: m[1], body: [] };
      sections.push(cur);
    } else (cur ? cur.body : pre).push(line);
  }
  return { pre: pre.join("\n"), sections: sections.map((s) => ({ name: s.name, body: s.body.join("\n").trim() })) };
}

export function joinSections({ pre, sections }) {
  const head = pre.trim() ? `${pre.trim()}\n\n` : "";
  return `${head}${sections.map((s) => `## ${s.name}\n${s.body ? `${s.body}\n` : ""}`).join("\n")}`;
}

const template = (name) => fs.readFileSync(path.join(TEMPLATE_DIR, name), "utf8");
const stripComments = (t) => t.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();

export class Notes {
  /** mode "desktop" or "cc": decides whether the Claude Code rules section is part of the rules. */
  constructor(dir, mode = "desktop") {
    this.dir = dir;
    this.mode = mode;
  }

  path(file) {
    return path.join(this.dir, FILES[file]);
  }

  /** Create missing files from the templates. Never overwrites the player's edits. */
  ensureFiles() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.path("campaign"))) fs.writeFileSync(this.path("campaign"), template("campaign.md"));
    if (!fs.existsSync(this.path("rules"))) {
      fs.writeFileSync(this.path("rules"), `${template("house_rules.base.md").trimEnd()}\n${template("house_rules.cc.md")}`);
    }
  }

  /** Replace campaign.md with a fresh template (callers archive the old one first). */
  resetCampaign() {
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.path("campaign"), template("campaign.md"));
  }

  /** True if campaign.md is still the untouched template (nothing to archive). */
  isPristine() {
    if (!fs.existsSync(this.path("campaign"))) return true;
    return fs.readFileSync(this.path("campaign"), "utf8").replace(/\s+/g, "") === template("campaign.md").replace(/\s+/g, "");
  }

  load(file) {
    this.ensureFiles();
    return fs.readFileSync(this.path(file), "utf8");
  }

  /**
   * House rules as Claude should see them: comments removed (the commented "Player notes" are
   * examples, not rules); Claude Desktop skips the Claude Code section; Claude Code mode adds it
   * (or the bullets it gained since) from the template if an older file lacks them.
   */
  rules() {
    const doc = splitSections(this.load("rules"));
    const isCC = (s) => slug(s.name) === slug(CC_SECTION);
    if (this.mode === "desktop") doc.sections = doc.sections.filter((s) => !isCC(s));
    else {
      const fresh = splitSections(template("house_rules.cc.md")).sections;
      const mine = doc.sections.find(isCC);
      if (!mine) doc.sections.push(...fresh);
      else {
        // a file from an older version gets the Claude Code rules added since (the player's lines stay)
        const have = new Set(mine.body.split("\n").map((l) => l.trim()));
        const add = fresh.find(isCC).body.split("\n").filter((l) => l.startsWith("- ") && !have.has(l.trim()));
        if (add.length) mine.body = [mine.body, ...add].join("\n");
      }
    }
    return stripComments(joinSections(doc));
  }

  read(file = "campaign", section) {
    const want = section ?? (file === "campaign" ? "Current State" : "all");
    if (file === "rules") {
      if (slug(want) === "all") return this.rules();
      const doc = splitSections(this.rules());
      const pick = fuzzyPick(want, doc.sections, (s) => [s.name]);
      if (!pick.item) throw new NotesError(`no section '${want}' in ${FILES.rules}; sections: ${doc.sections.map((s) => s.name).join(", ")}`);
      return `## ${pick.item.name}\n${pick.item.body || "(empty)"}`;
    }
    const text = this.load(file);
    if (slug(want) === "all") return text.trim();
    const doc = splitSections(text);
    const pick = fuzzyPick(want, doc.sections, (s) => [s.name]);
    if (!pick.item) throw new NotesError(`no section '${want}' in ${FILES[file]}; sections: ${doc.sections.map((s) => s.name).join(", ")}`);
    return `## ${pick.item.name}\n${pick.item.body || "(empty)"}`;
  }

  /** write replaces a section's text; append adds to it. Missing sections are created. */
  update(op, file = "campaign", section, text) {
    if (!section) throw new NotesError(`${op} needs a section, e.g. section="Inventory"`);
    return this.batch(op, file, { [section]: text })[0];
  }

  /** Several sections in one atomic file write. Returns the section names touched. */
  batch(op, file = "campaign", sections) {
    const entries = Object.entries(sections ?? {});
    if (!entries.length) throw new NotesError(`${op} needs a section and text, or sections={"Name": "text", ...}`);
    const doc = splitSections(this.load(file));
    const names = [];
    for (const [section, text] of entries) {
      if (!String(section).trim()) throw new NotesError("section names can't be empty");
      if (typeof text !== "string" || (op === "append" && !text.trim())) throw new NotesError(`${op} '${section}' needs text`);
      let s = doc.sections.find((x) => slug(x.name) === slug(section));
      if (!s) {
        s = { name: String(section).trim(), body: "" };
        const savedRooms = doc.sections.findIndex((x) => slug(x.name) === "saved_rooms");
        doc.sections.splice(savedRooms === -1 ? doc.sections.length : savedRooms, 0, s);
      }
      s.body = op === "write" ? text.trim() : [s.body, text.trim()].filter(Boolean).join("\n");
      names.push(s.name);
    }
    writeFileAtomic(this.path(file), joinSections(doc));
    return names;
  }

  addSavedRoom(name) {
    const doc = splitSections(this.load("campaign"));
    const s = doc.sections.find((x) => slug(x.name) === "saved_rooms");
    const line = `- ${name}`;
    if (s && s.body.split("\n").some((l) => slug(l) === slug(line))) return;
    this.update("append", "campaign", s?.name ?? "Saved rooms", line);
  }
}
