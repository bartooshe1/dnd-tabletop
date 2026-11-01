// Pictures the player adds on the game page (chat attachments, a character portrait, map
// backgrounds). Stored as images/<random id>.<ext> in the data folder. Only real image files
// are accepted (checked by their first bytes, not by what the browser claims).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const KINDS = [
  { ext: "jpg", type: "image/jpeg", is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png", type: "image/png", is: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "gif", type: "image/gif", is: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { ext: "webp", type: "image/webp", is: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];
const ID = /^[a-f0-9]{16}$/;

export class ImageError extends Error {}

export class ImageStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "images");
  }

  /** Save a picture sent as base64 (a data: URL prefix is fine). Returns its id. */
  save(base64) {
    const b64 = String(base64 ?? "").replace(/^data:[^,]*,/, "");
    const buf = Buffer.from(b64, "base64");
    if (!buf.length) throw new ImageError("that picture is empty");
    if (buf.length > MAX_IMAGE_BYTES) throw new ImageError(`that picture is too big (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`);
    const kind = KINDS.find((k) => k.is(buf));
    if (!kind) throw new ImageError("that file isn't a JPEG, PNG, GIF or WebP picture");
    const id = crypto.randomBytes(8).toString("hex");
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${id}.${kind.ext}`), buf);
    return id;
  }

  /** { file, type, name } for an id, or null. Ids are checked, so no path can sneak in. */
  find(id) {
    if (!ID.test(String(id))) return null;
    for (const k of KINDS) {
      const file = path.join(this.dir, `${id}.${k.ext}`);
      if (fs.existsSync(file)) return { file, type: k.type, name: `images/${id}.${k.ext}` };
    }
    return null;
  }

  read(id) {
    const f = this.find(id);
    return f ? { buf: fs.readFileSync(f.file), type: f.type } : null;
  }

  dataUri(id) {
    const r = this.read(id);
    return r ? `data:${r.type};base64,${r.buf.toString("base64")}` : null;
  }
}
