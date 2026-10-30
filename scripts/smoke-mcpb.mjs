// Unpacks a built .mcpb into a fresh dir and drives it over stdio the way a host would:
// list tools, call each with sample args, read every ui:// resource.
// Usage: node scripts/smoke-mcpb.mjs <file.mcpb> <outDir> [toolName argsJson ...]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const [mcpbFile, outDir, ...calls] = process.argv.slice(2);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const mcpbCli = path.join(ROOT, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
execFileSync(process.execPath, [mcpbCli, "unpack", mcpbFile, outDir], { stdio: "ignore" });

const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
const args = manifest.server.mcp_config.args.map((a) => a.replace("${__dirname}", outDir));
const dataDir = path.join(outDir, "_data");

const client = new Client(
  { name: "smoke", version: "0" },
  { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } },
);
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args,
    env: { ...process.env, DND_DATA_DIR: dataDir },
    stderr: "inherit",
  }),
);
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => `${t.name}${t._meta?.ui?.resourceUri ? ` -> ${t._meta.ui.resourceUri}` : ""}`).join(", "));

const plan = calls.length ? [] : tools.map((t) => [t.name, {}]);
for (let i = 0; i < calls.length; i += 2) plan.push([calls[i], JSON.parse(calls[i + 1] ?? "{}")]);
for (const [name, a] of plan) {
  const res = await client.callTool({ name, arguments: a });
  const text = res.content.map((c) => c.text).join(" | ");
  console.log(`${name}(${JSON.stringify(a)}) ->`, text.slice(0, 300), res._meta ? `[_meta keys: ${Object.keys(res._meta)}]` : "");
}
for (const uri of new Set(tools.map((t) => t._meta?.ui?.resourceUri).filter(Boolean))) {
  const r = await client.readResource({ uri });
  console.log("resource:", r.contents[0].uri, r.contents[0].mimeType, `${r.contents[0].text.length} chars`);
}
await client.close();
