import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute } from "../engine/executor.js";
import { emptyCampaign, activeMap, findToken } from "../engine/model.js";
import { RoomStore } from "../engine/rooms.js";

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dnd-test-"));
}

/** A tiny harness: run batches against an evolving campaign. */
export function table({ units = "metric", detail = "lean", roomsDir = null } = {}) {
  const rooms = new RoomStore(roomsDir);
  const ctx = { units, detail, rooms, random: () => 0.5 };
  let campaign = emptyCampaign();
  return {
    ctx,
    rooms,
    get c() {
      return campaign;
    },
    set c(v) {
      campaign = v;
    },
    run(text) {
      const res = execute(campaign, text, ctx);
      if (res.ok) {
        campaign = res.campaign;
        for (const e of res.effects) if (e.kind === "saveRoom" && roomsDir) rooms.commit(e.room);
      } else rooms.discardStaged();
      return res;
    },
    ok(text) {
      const res = this.run(text);
      if (!res.ok) throw new Error(`expected ok for ${JSON.stringify(text)}, got:\n${res.errors.join("\n")}`);
      return res;
    },
    fail(text) {
      const res = this.run(text);
      if (res.ok) throw new Error(`expected failure for ${JSON.stringify(text)}`);
      return res;
    },
    map() {
      return activeMap(campaign);
    },
    at(cell) {
      const [r, c] = cell.split("x").map(Number);
      const m = activeMap(campaign);
      return { terrain: m.terrain[r - 1][c - 1], token: m.tokens[r - 1][c - 1] };
    },
    where(id) {
      const p = findToken(activeMap(campaign), id);
      return p ? `${p.r + 1}x${p.c + 1}` : null;
    },
  };
}
