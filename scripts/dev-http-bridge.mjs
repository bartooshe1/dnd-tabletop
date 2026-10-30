// DEV ONLY (never shipped in the .mcpb): exposes a stdio MCP server over Streamable HTTP
// so browser test hosts such as the ext-apps basic-host can talk to it.
// Usage: node scripts/dev-http-bridge.mjs [port] [serverScript] [dataDir]
import http from "node:http";
import { randomUUID } from "node:crypto";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const port = Number(process.argv[2] ?? 3001);
const script = process.argv[3] ?? "server/index.js";
if (process.argv[4]) process.env.DND_DATA_DIR = process.argv[4];

let session = null;

async function newSession() {
  const child = new StdioClientTransport({ command: process.execPath, args: [script], stderr: "inherit", env: process.env });
  const web = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  web.onmessage = (msg) => child.send(msg).catch((e) => process.stderr.write(`[bridge] to child: ${e}\n`));
  child.onmessage = (msg) => web.send(msg).catch((e) => process.stderr.write(`[bridge] to web: ${e}\n`));
  child.onclose = () => process.stderr.write("[bridge] child closed\n");
  await child.start();
  await web.start();
  return { child, web };
}

http
  .createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (!req.url.startsWith("/mcp")) return res.writeHead(404).end();
    let body;
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
      const isInit = [body].flat().some((m) => m?.method === "initialize");
      if (isInit) {
        if (session) await session.child.close().catch(() => {});
        session = await newSession();
      }
    }
    if (!session) return res.writeHead(400).end("no session");
    await session.web.handleRequest(req, res, body);
  })
  .listen(port, () => process.stderr.write(`[bridge] http://localhost:${port}/mcp -> ${script}\n`));
