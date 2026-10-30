// The plugin loads in every Claude Code session; only a session that plays may hold the game port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers.mjs";
import { createCcServer } from "../cc/server.js";

test("an idle Claude Code session doesn't open the game port; the first game call does", async () => {
  const config = { dataDir: tmpDir(), units: "metric", detail: "lean", waitMs: 2000, idleStop: 2, port: 47980, lan: false, openBrowser: false };
  const { page, startPage } = createCcServer(config, { browser: () => {} });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(page.server, null, "nothing listens yet");
  const port = await startPage();
  assert.equal(port, 47980);
  assert.equal(await startPage(), port, "started once");
  assert.equal((await fetch(`http://127.0.0.1:${port}/__instance`)).status, 200);
  await page.close();
});
