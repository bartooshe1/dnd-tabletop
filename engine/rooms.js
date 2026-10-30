// Built-in layouts (read-only, layouts/*.json) and the campaign's saved rooms (<dataDir>/rooms/*.json).
import fs from "node:fs";
import path from "node:path";
import { fullLegend, gridFromRows } from "./ascii.js";
import { fuzzyPick, slug } from "./fuzzy.js";
import { writeFileAtomic } from "./store.js";
import { log } from "./log.js";
import { LAYOUT_DIR } from "./paths.js";

export { LAYOUT_DIR };

let builtins = null;

/** Parse one hand-made layout file: { name, description, scale?, legend?, rows: [ascii] }. */
export function parseLayout(id, raw) {
  const g = gridFromRows(raw.rows, { ...fullLegend(), ...(raw.legend ?? {}) });
  if (g.errors.length) throw new Error(`layout ${id}: ${g.errors.join("; ")}`);
  return {
    id,
    name: raw.name ?? id,
    description: raw.description ?? "",
    builtin: true,
    cols: g.cols,
    rows: g.rows,
    scale: raw.scale ?? 1.5,
    base: raw.base ?? g.base,
    terrain: g.terrain,
    tokens: g.tokens.map((t) => ({ r: t.r, c: t.c, type: t.what })),
  };
}

export function builtinLayouts() {
  if (!builtins) {
    builtins = fs
      .readdirSync(LAYOUT_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => parseLayout(f.replace(/\.json$/, ""), JSON.parse(fs.readFileSync(path.join(LAYOUT_DIR, f), "utf8"))));
  }
  return builtins;
}

export class RoomStore {
  constructor(dir) {
    this.dir = dir;
    this.staged = new Map();
  }

  saved() {
    if (!this.dir || !fs.existsSync(this.dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort()) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")));
      } catch (e) {
        log(`skipping unreadable room ${f}: ${e.message}`);
      }
    }
    return out;
  }

  all() {
    const saved = new Map(this.saved().map((r) => [r.id, r]));
    for (const [id, r] of this.staged) saved.set(id, r);
    return [...builtinLayouts(), ...saved.values()];
  }

  find(name) {
    return fuzzyPick(name, this.all(), (r) => [r.id, r.name]);
  }

  listText() {
    const fmt = (r) => `${r.id} ${r.cols}x${r.rows}${r.description ? `: ${r.description}` : ""}`;
    const all = this.all();
    const saved = all.filter((r) => !r.builtin);
    return `rooms (WxH): ${all.filter((r) => r.builtin).map(fmt).join("; ")}${saved.length ? ` | saved: ${saved.map((r) => `${r.id} ${r.cols}x${r.rows}`).join("; ")}` : ""}`;
  }

  /** Make a room visible to later commands in the same batch (before commit). */
  stage(room) {
    if (builtinLayouts().some((b) => b.id === room.id)) {
      const err = new Error(`'${room.id}' is a built-in room`);
      err.hint = "pick another name";
      throw err;
    }
    this.staged.set(room.id, room);
  }

  discardStaged() {
    this.staged.clear();
  }

  commit(room) {
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(path.join(this.dir, `${slug(room.id)}.json`), JSON.stringify(room));
    this.staged.delete(room.id);
  }
}
