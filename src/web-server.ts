import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });

import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "./mcp-server.ts";
import { GitHubClient } from "./github.ts";
import { mcpToolProvider } from "./tool-provider.ts";
import { repoRoot } from "./tools.ts";
import { parseBudget } from "./review.ts";
import { createWebApp, parseList, parsePort } from "./web-app.ts";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

let maxBudgetUsd: number;
try {
  maxBudgetUsd = parseBudget(process.env.REVIEW_MAX_BUDGET_USD);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

let port: number;
try {
  port = parsePort(process.env.WEB_PORT, 3334);
} catch (e) {
  console.error(`WEB_PORT: ${(e as Error).message}`);
  process.exit(1);
}
// Local use binds to loopback. Hosted (Azure Container Apps) binds to 0.0.0.0 behind the
// platform's sign-in, and must be told its public host names and who may use it.
const bindHost = process.env.WEB_HOST?.trim() || "127.0.0.1";
const publicHosts = parseList(process.env.PUBLIC_HOSTS).map((h) => h.toLowerCase());
const allowedUsers = parseList(process.env.ALLOWED_GITHUB_USERS);
const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(bindHost);
if (!isLoopback && allowedUsers.length === 0) {
  console.error(
    `Refusing to listen on ${bindHost} without ALLOWED_GITHUB_USERS: anyone who could reach it ` +
      "could spend your API credits. Set it (and put the app behind Container Apps authentication), " +
      "or bind to 127.0.0.1.",
  );
  process.exit(1);
}

const root = repoRoot();
const githubToken = process.env.GITHUB_TOKEN || undefined;
const github = new GitHubClient({ token: githubToken });
const model = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";

// A private MCP server for both agents: ask gets all repo and PR tools, review gets its
// read-only subset. Posting goes through /api/review/post, never through the agent.
const mcpToken = randomBytes(24).toString("hex");
const mcp = await startHttpServer({ root, port: 0, token: mcpToken, github });

const here = path.dirname(fileURLToPath(import.meta.url));
const app = createWebApp({
  root,
  model,
  github,
  canPost: Boolean(githubToken),
  maxBudgetUsd: maxBudgetUsd!,
  openTools: () => mcpToolProvider(mcp.url, mcpToken),
  mcp: { url: mcp.url, token: mcpToken },
  allowedHosts: [`localhost:${port!}`, `127.0.0.1:${port!}`, ...publicHosts],
  allowedUsers: allowedUsers.length ? allowedUsers : undefined,
  staticDir: path.resolve(here, "../web/dist/web/browser"),
});

app.listen(port!, bindHost, () => {
  console.error(`Codebase Q&A web UI: http://localhost:${port}`);
  if (publicHosts.length) console.error(`Also answering to: ${publicHosts.join(", ")}`);
  if (allowedUsers.length) console.error(`Signed-in GitHub users allowed: ${allowedUsers.join(", ")}`);
  console.error(`Repo: ${root}`);
  console.error(`GitHub: ${githubToken ? "token set (posting available)" : "no token (public PRs only, no posting)"}`);
});
