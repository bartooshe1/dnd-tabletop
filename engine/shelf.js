// Several campaigns. The active one lives in the data folder itself, so every other module
// keeps working unchanged; the others wait in campaigns/<id>/. Switching copies files both
// ways and never deletes a campaign: the old one is shelved before the new one comes down.
// Older archives (archive/<stamp>/, from starting a new campaign) can be brought back too.
import fs from "node:fs";
import path from "node:path";
import { slug } from "./fuzzy.js";
import { splitSections } from "./notes.js";

/** The files that belong to one campaign. House rules, saved rooms and logs are shared. */
export const CAMPAIGN_FILES = ["campaign.md", "campaign.json", "campaign.json.bak", "chat.json"];

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "campaign.json"), "utf8")).meta ?? {};
  } catch {
    return {};
  }
}

/** A campaign's title, or a name made from its character when it was never given one. */
export function titleOf(dir) {
  const meta = readMeta(dir);
  if (meta.title) return String(meta.title);
  try {
    const doc = splitSections(fs.readFileSync(path.join(dir, "campaign.md"), "utf8"));
    const body = doc.sections.find((s) => slug(s.name) === "character")?.body.replace(/<!--[\s\S]*?-->/g, "").trim() ?? "";
    const first = body.split("\n")[0]?.replace(/[*_#`]/g, "").split(/[·,(|]/)[0].trim();
    if (first) return `${first.slice(0, 40)}'s campaign`;
  } catch {
    /* fall through */
  }
  return "Untitled campaign";
}

const hasCampaign = (dir) => fs.existsSync(path.join(dir, "campaign.json")) || fs.existsSync(path.join(dir, "campaign.md"));
const mtime = (dir) => {
  try {
    return Math.max(...CAMPAIGN_FILES.map((f) => fs.statSync(path.join(dir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0));
  } catch {
    return 0;
  }
};

export class Shelf {
  constructor(dataDir) {
    this.root = dataDir;
    this.dir = path.join(dataDir, "campaigns");
  }

  /** Shelved campaigns first (newest first), then archives whose title isn't shelved or active. */
  list(activeTitle = null) {
    const dirs = (base) =>
      fs.existsSync(base)
        ? fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && hasCampaign(path.join(base, d.name))).map((d) => path.join(base, d.name))
        : [];
    const saved = dirs(this.dir)
      .map((dir) => ({ id: path.basename(dir), title: titleOf(dir), kind: "saved", dir, at: mtime(dir) }))
      .sort((a, b) => b.at - a.at);
    const taken = new Set([...saved.map((s) => slug(s.title)), slug(activeTitle ?? "")]);
    const archives = [];
    for (const dir of dirs(path.join(this.root, "archive")).sort().reverse()) {
      const title = titleOf(dir);
      if (taken.has(slug(title))) continue;
      taken.add(slug(title));
      archives.push({ id: path.basename(dir), title, kind: "archive", dir, at: mtime(dir) });
    }
    return [...saved, ...archives];
  }

  /** Copy the active campaign onto the shelf, replacing an older copy of the same campaign. */
  stash(title) {
    const base = slug(title) || "untitled";
    const mine = readMeta(this.root).startedStamp ?? null;
    let id = base;
    // two different campaigns may share a title: only the same campaign (same start) is replaced
    for (let n = 2; fs.existsSync(path.join(this.dir, id)) && readMeta(path.join(this.dir, id)).startedStamp !== mine; n++) id = `${base}_${n}`;
    const dest = path.join(this.dir, id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const f of CAMPAIGN_FILES) {
      const src = path.join(this.root, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
    }
    if (!hasCampaign(dest)) throw new Error(`shelving '${title}' failed; nothing was switched`);
    return id;
  }

  /** Make `entry` the active campaign. A shelved copy leaves the shelf; an archive stays as it is. */
  restore(entry) {
    for (const f of CAMPAIGN_FILES) {
      const src = path.join(entry.dir, f);
      const dst = path.join(this.root, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
      else fs.rmSync(dst, { force: true });
    }
    if (entry.kind === "saved") fs.rmSync(entry.dir, { recursive: true, force: true });
  }
}
