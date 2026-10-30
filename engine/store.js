// Persistence: campaign.json with atomic writes, a .bak of the last good state,
// and recovery from corrupt files (the bad file is kept aside, never deleted).
import fs from "node:fs";
import path from "node:path";
import { emptyCampaign } from "./model.js";
import { log } from "./log.js";

export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows can refuse a rename over a file another process holds open; fall back to copy.
    fs.copyFileSync(tmp, file);
    fs.rmSync(tmp, { force: true });
  }
}

function valid(c) {
  return c && typeof c === "object" && Array.isArray(c.maps) && c.tokens && typeof c.tokens === "object";
}

function normalize(c) {
  const base = emptyCampaign();
  const out = { ...base, ...c };
  out.types ??= {};
  out.meta = out.meta && typeof out.meta === "object" ? out.meta : {};
  out.dice = Array.isArray(out.dice) ? out.dice : [];
  for (const t of Object.values(out.tokens)) t.status ??= [];
  for (const m of out.maps) m.base ??= "floor";
  if (out.active && !out.maps.some((m) => m.name === out.active)) out.active = out.maps[0]?.name ?? null;
  return out;
}

export class CampaignStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "campaign.json");
    this.recovered = null; // message to surface once, if we had to recover
    this.seen = null; // mtime+size of campaign.json when we last read or wrote it
  }

  #stat() {
    try {
      const st = fs.statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "missing";
    }
  }

  /** True if another process (the other front end) wrote campaign.json since we last touched it. */
  changedOnDisk() {
    return this.seen !== null && this.#stat() !== this.seen;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.seen = "missing";
      return emptyCampaign();
    }
    const read = (f) => {
      try {
        const c = JSON.parse(fs.readFileSync(f, "utf8"));
        return valid(c) ? normalize(c) : null;
      } catch {
        return null;
      }
    };
    const main = read(this.file);
    this.seen = this.#stat();
    if (main) return main;
    const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(this.file, aside);
    const bak = read(`${this.file}.bak`);
    this.recovered = bak
      ? `campaign.json was unreadable; restored the previous save (bad file kept as ${path.basename(aside)})`
      : `campaign.json was unreadable; started a fresh map state (bad file kept as ${path.basename(aside)})`;
    log(this.recovered);
    return bak ?? emptyCampaign();
  }

  save(campaign) {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        fs.copyFileSync(this.file, `${this.file}.bak`);
      } catch (e) {
        log(`could not write backup: ${e.message}`);
      }
    }
    writeFileAtomic(this.file, JSON.stringify(campaign));
    this.seen = this.#stat();
  }

  /** One-time recovery notice for the next tool result. */
  takeNotice() {
    const n = this.recovered;
    this.recovered = null;
    return n;
  }
}
