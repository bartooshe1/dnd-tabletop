#!/usr/bin/env node
// Claude Code mode entry point: MCP over stdio (stdout is MCP only) + the local game page.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCcServer } from "./server.js";
import { loadCcConfig } from "./config.js";
import { log } from "../engine/log.js";

const config = loadCcConfig();
const { server, game, page } = createCcServer(config);
await server.connect(new StdioServerTransport());
log(`ready; data in ${config.dataDir}`);

let done = false;
const stop = () => {
  if (done) return;
  done = true;
  game.shutdown();
  page.close().finally(() => process.exit(0));
};
process.stdin.on("end", stop); // Claude Code closed the session
process.stdin.on("close", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("uncaughtException", (e) => log(`uncaught: ${e.stack ?? e}`));
process.on("unhandledRejection", (e) => log(`unhandled: ${e?.stack ?? e}`));
