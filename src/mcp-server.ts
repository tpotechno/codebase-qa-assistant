import type { Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { readFile, searchCode } from "./tools.ts";
import { searchDocsText } from "./docs.ts";

export const SERVER_NAME = "codebase-qa";
export const SERVER_VERSION = "0.2.0";

const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  isError: t.startsWith("Error:"),
});

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

/** Build an MCP server whose tools are confined to one repository root. */
export function createMcpServer(root: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description:
        "Case-insensitive substring search across text files in the repository. " +
        "Returns up to k hits as file:line with one line of context on each side. " +
        "Use this first to locate relevant code, then read_file to inspect it.",
      inputSchema: {
        query: z.string().min(1).describe("Text to search for, e.g. a symbol or string literal."),
        k: z.number().int().min(1).max(25).optional().describe("Maximum hits (default 8)."),
        path_glob: z.string().optional().describe("Optional path prefix, e.g. 'src/app/'."),
      },
      annotations: readOnly,
    },
    async (args) => text(await searchCode(args, root)),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a repository file by relative path, with line numbers. At most 200 lines per call; " +
        "pass start/end to page through larger files. Paths outside the repository are refused.",
      inputSchema: {
        path: z.string().min(1).describe("Path relative to the repository root."),
        start: z.number().int().min(1).optional().describe("First line (1-based)."),
        end: z.number().int().min(1).optional().describe("Last line (inclusive)."),
      },
      annotations: readOnly,
    },
    async (args) => text(await readFile(args, root)),
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search documentation",
      description:
        "Search the repository's documentation (READMEs, design docs, ADRs) for passages relevant " +
        "to a natural-language question. Returns ranked chunks with file:line and heading. " +
        "Use this for 'why' and 'how is this meant to work' questions; use search_code for symbols.",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language question or keywords."),
        k: z.number().int().min(1).max(10).optional().describe("Passages to return (default 5)."),
      },
      annotations: readOnly,
    },
    async ({ query, k }) => text(await searchDocsText(root, query, k)),
  );

  return server;
}

function bearerAuth(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!token) return next();
    const header = req.headers.authorization ?? "";
    const supplied = Buffer.from(header.replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(token);
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return next();
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  };
}

export interface HttpServerOptions {
  root: string;
  port?: number;      // 0 = pick a free port (used by tests)
  host?: string;      // default 127.0.0.1 (local only)
  token?: string;     // if set, clients must send "Authorization: Bearer <token>"
}

/**
 * Serve the MCP server over Streamable HTTP at POST /mcp.
 * Stateless: each request gets a fresh server + transport, which keeps the server
 * horizontally scalable and easy to deploy behind a load balancer.
 */
export async function startHttpServer(opts: HttpServerOptions): Promise<{ server: Server; url: string }> {
  const host = opts.host ?? "127.0.0.1";
  const app = createMcpExpressApp({ host });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION });
  });

  app.post("/mcp", bearerAuth(opts.token), async (req, res) => {
    const server = createMcpServer(opts.root);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null });
      }
    }
  });

  // Stateless server: no server-initiated streams or sessions to resume or delete.
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  return new Promise((resolve, reject) => {
    const server = app.listen(opts.port ?? 3333, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({ server, url: `http://${host}:${port}/mcp` });
    });
    server.on("error", reject);
  });
}
