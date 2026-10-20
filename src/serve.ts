import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });

import { startHttpServer } from "./mcp-server.ts";
import { GitHubClient } from "./github.ts";
import { repoRoot } from "./tools.ts";

const port = Number(process.env.MCP_PORT ?? 3333);
const host = process.env.MCP_HOST ?? "127.0.0.1";
const token = process.env.MCP_AUTH_TOKEN || undefined;
const github = new GitHubClient({ token: process.env.GITHUB_TOKEN });
const allowPost = process.env.GITHUB_ALLOW_POST === "true";

if (host !== "127.0.0.1" && host !== "localhost" && !token) {
  console.error("Refusing to listen on a non-local host without MCP_AUTH_TOKEN set.");
  process.exit(1);
}
if (allowPost && !github.hasToken) {
  console.error("GITHUB_ALLOW_POST=true has no effect without GITHUB_TOKEN; post_review stays disabled.");
}

const { url } = await startHttpServer({ root: repoRoot(), port, host, token, github, allowPost });
console.error(`MCP server "codebase-qa" listening at ${url}`);
console.error(`Repo: ${repoRoot()}`);
console.error(token ? "Auth: bearer token required" : "Auth: none (local only)");
console.error(
  `GitHub: ${github.hasToken ? "token set" : "no token (public repos only, 60 requests/hour)"}; ` +
    `post_review ${allowPost && github.hasToken ? "ENABLED" : "disabled"}`,
);
