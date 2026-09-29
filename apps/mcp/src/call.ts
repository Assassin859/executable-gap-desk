/**
 * Spawns the stdio server the way Cursor does and calls one tool.
 *   pnpm --filter @gapdesk/mcp call                 list tools
 *   pnpm --filter @gapdesk/mcp call check_gate NVDA  call with {"ticker":"NVDA"} (or pass JSON)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const FIRST_ARG: Record<string, string> = { resolve: "query", get_market_state: "asset", quote_route: "symbol", check_gate: "ticker" };

const [name, raw, ...flags] = process.argv.slice(2);
const save = flags.includes("--save") || raw === "--save";
const args = !raw || raw === "--save" ? {} : raw.trim().startsWith("{") ? JSON.parse(raw) : { [FIRST_ARG[name ?? ""] ?? "query"]: raw };

// Launch exactly what Cursor launches: the gap-desk entry of .cursor/mcp.json.
const config = JSON.parse(readFileSync(resolve(repoRoot, ".cursor/mcp.json"), "utf8")) as {
  mcpServers: Record<string, { command: string; args?: string[]; cwd?: string }>;
};
const entry = config.mcpServers["gap-desk"];
if (!entry) throw new Error(".cursor/mcp.json has no gap-desk server.");
const expand = (s: string) => s.replaceAll("${workspaceFolder}", repoRoot);
const transport = new StdioClientTransport({
  command: entry.command === "node" ? process.execPath : entry.command,
  args: (entry.args ?? []).map(expand),
  cwd: expand(entry.cwd ?? repoRoot),
  stderr: "inherit",
});
const client = new Client({ name: "gap-mcp-call", version: "0.1.0" });
await client.connect(transport);

try {
  const tools = await client.listTools();
  if (!name) {
    for (const t of tools.tools) console.log(`${t.name.padEnd(18)} ${t.annotations?.readOnlyHint ? "read-only " : ""}${t.description ?? ""}`);
  } else {
    const started = Date.now();
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    console.log(text);
    if (save) {
      const dir = resolve(repoRoot, "receipts/mcp");
      mkdirSync(dir, { recursive: true });
      const file = resolve(dir, `${new Date(started).toISOString().replace(/[:.]/g, "-")}-${name}.json`);
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {}
      const record = { at: new Date(started).toISOString(), elapsedMs: Date.now() - started, transport: "stdio", launch: { config: ".cursor/mcp.json", server: "gap-desk", command: entry.command, args: entry.args }, tools: tools.tools.map((t) => t.name), tool: name, arguments: args, isError: res.isError ?? false, result: body };
      writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
      console.error(`saved ${file}`);
    }
    if (res.isError) process.exitCode = 1;
  }
} finally {
  await client.close();
}
