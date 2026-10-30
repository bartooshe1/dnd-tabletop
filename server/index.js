#!/usr/bin/env node
// Entry point: stdio only. stdout carries MCP JSON-RPC; logs go to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { loadConfig } from "../engine/config.js";
import { log } from "../engine/log.js";

const config = loadConfig();
const { server } = createServer(config);
await server.connect(new StdioServerTransport());
log(`ready; data in ${config.dataDir} (units ${config.units}, ${config.detail})`);

process.on("uncaughtException", (e) => log(`uncaught: ${e.stack ?? e}`));
process.on("unhandledRejection", (e) => log(`unhandled: ${e?.stack ?? e}`));
