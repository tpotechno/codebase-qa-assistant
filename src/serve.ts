import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });

import { startHttpServer } from "./mcp-server.ts";
import { repoRoot } from "./tools.ts";

const port = Number(process.env.MCP_PORT ?? 3333);
const host = process.env.MCP_HOST ?? "127.0.0.1";
const token = process.env.MCP_AUTH_TOKEN || undefined;

if (host !== "127.0.0.1" && host !== "localhost" && !token) {
  console.error("Refusing to listen on a non-local host without MCP_AUTH_TOKEN set.");
  process.exit(1);
}

const { url } = await startHttpServer({ root: repoRoot(), port, host, token });
console.error(`MCP server "codebase-qa" listening at ${url}`);
console.error(`Repo: ${repoRoot()}`);
console.error(token ? "Auth: bearer token required" : "Auth: none (local only)");
