// Spike: one tool that renders a hardcoded 5x5 map card through MCP Apps.
// Verifies inline rendering from an .mcpb in Claude Desktop before the real build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppTool,
  registerAppResource,
  getUiCapability,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "spike.html"), "utf8");
const URI = "ui://dnd/spike";

const server = new McpServer({ name: "dnd-tabletop-spike", version: "0.0.1" });

registerAppResource(server, "D&D spike map", URI, { description: "Spike 5x5 map card" }, async () => ({
  contents: [{ uri: URI, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { prefersBorder: false } } }],
}));

registerAppTool(
  server,
  "show_spike",
  {
    title: "Show spike map",
    description: "Render a test 5x5 D&D map card inline.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: URI } },
  },
  async () => {
    const ui = getUiCapability(server.server.getClientCapabilities());
    const client = server.server.getClientVersion();
    process.stderr.write(`[spike] show_spike called; client=${JSON.stringify(client)} ui=${JSON.stringify(ui)}\n`);
    return {
      content: [{ type: "text", text: `spike map shown (client ui ext: ${ui ? "yes" : "no"})` }],
      _meta: {
        "dnd-tabletop/view": {
          rows: 5,
          cols: 5,
          cells: ["#####", "#...#", "#.@.#", "#..w#", "##+##"],
          client: client?.name ?? "?",
          uiExt: !!ui,
        },
      },
    };
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write("[spike] ready\n");
