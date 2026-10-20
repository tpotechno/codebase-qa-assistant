import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { executeTool, toolDefinitions } from "./tools.ts";

export interface ToolResult {
  content: string;
  isError: boolean;
}

/** Where the agent gets its tools from. The agent loop doesn't care which. */
export interface ToolProvider {
  readonly source: string;
  listTools(): Promise<Anthropic.Tool[]>;
  callTool(name: string, input: unknown): Promise<ToolResult>;
  close(): Promise<void>;
}

/** Phase 1 behavior: tools run in-process. */
export function localToolProvider(): ToolProvider {
  return {
    source: "local",
    listTools: async () => toolDefinitions,
    callTool: async (name, input) => {
      const content = await executeTool(name, input);
      return { content, isError: content.startsWith("Error:") };
    },
    close: async () => {},
  };
}

/**
 * Phase 2: tools come from an MCP server over Streamable HTTP.
 * Tool definitions are discovered at runtime (tools/list) and translated into the
 * Messages API tool format, so new server tools appear to the agent with no code change.
 */
export async function mcpToolProvider(url: string, token?: string): Promise<ToolProvider> {
  const client = new Client({ name: "codebase-qa-agent", version: "0.2.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);

  return {
    source: `mcp:${url}`,
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }));
    },
    async callTool(name, input) {
      const result = await client.callTool({ name, arguments: (input ?? {}) as Record<string, unknown> });
      const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const content = blocks
        .map((b) => (b.type === "text" ? (b.text ?? "") : `[${b.type} content omitted]`))
        .join("\n");
      return { content, isError: Boolean(result.isError) };
    },
    close: () => client.close(),
  };
}

/** Pick a provider from env: MCP_SERVER_URL set -> MCP, otherwise local. */
export async function toolProviderFromEnv(): Promise<ToolProvider> {
  const url = process.env.MCP_SERVER_URL;
  return url ? mcpToolProvider(url, process.env.MCP_AUTH_TOKEN || undefined) : localToolProvider();
}
