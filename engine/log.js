// stdout is reserved for MCP JSON-RPC. Everything human-readable goes to stderr.
export function log(...parts) {
  const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  process.stderr.write(`[dnd-tabletop] ${line}\n`);
}
