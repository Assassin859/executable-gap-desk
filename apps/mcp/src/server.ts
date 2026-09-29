#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { callTool, defaultDeps, INPUTS, TOOLS, ToolInputError, type ToolName } from "./tools";

// stdout is the JSON-RPC channel; anything else written there corrupts the session.
console.log = console.error;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const envFile = resolve(repoRoot, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const server = new McpServer({ name: "executable-gap-desk", version: "0.1.0" });
const deps = defaultDeps();

for (const name of Object.keys(TOOLS) as ToolName[]) {
  const tool = TOOLS[name];
  server.registerTool(
    name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: INPUTS[name],
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: unknown) => {
      try {
        const out = await callTool(name, args, deps);
        return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
      } catch (err) {
        const msg = err instanceof ToolInputError ? err.message : `${name} failed: ${err instanceof Error ? err.message : String(err)}`;
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
console.error("executable-gap-desk MCP server ready on stdio (read-only tools: " + Object.keys(TOOLS).join(", ") + ")");
