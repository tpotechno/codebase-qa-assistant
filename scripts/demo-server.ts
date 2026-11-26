/**
 * Runs the web UI with a scripted stand-in for Claude, so the interface can be developed,
 * demoed, and screenshotted without an API key or any spend.
 *
 *   npm run web:build && npm run web:demo   ->  http://localhost:3335
 *
 * The repo tools are real (they read this repository through the real MCP server); only the
 * model's decisions and words are scripted. The review uses a sample pull request
 * (acme/widgets#7) served by an in-memory GitHub, so nothing touches github.com.
 *
 * This is also what the public Azure deployment runs (see docs/azure_deployment.md):
 *   DEMO_HOST     address to bind (default 127.0.0.1; the container uses 0.0.0.0)
 *   DEMO_PORT     port (default 3335)
 *   PUBLIC_HOSTS  comma-separated public host names to answer to, e.g. the Container App's FQDN
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "../src/mcp-server.ts";
import { GitHubClient } from "../src/github.ts";
import { mcpToolProvider } from "../src/tool-provider.ts";
import { createWebApp, parsePort } from "../src/web-app.ts";
import { RepoRegistry, repoPolicyFromEnv } from "../src/repos.ts";
import { scriptedAnthropic } from "./demo-model.ts";
import { fakeGitHub } from "../test/fixtures/fake-github.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const port = parsePort(process.env.DEMO_PORT, 3335);
const bindHost = process.env.DEMO_HOST?.trim() || "127.0.0.1";
const publicHosts = (process.env.PUBLIC_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REVIEW = {
  summary:
    "Reading the port from the environment is the right move, but the change drops the default, so the server starts on `NaN` when `PORT` is unset. It also starts listening on every network interface, which isn't mentioned in the description.",
  verdict: "needs_changes",
  comments: [
    {
      path: "src/server.ts",
      line: 2,
      severity: "blocker",
      body: "`Number(process.env.PORT)` is `NaN` when `PORT` isn't set, and `app.listen(NaN)` picks a random port. Keep the old default: `Number(process.env.PORT ?? 3000)`.",
    },
    {
      path: "src/server.ts",
      line: 3,
      severity: "suggestion",
      body: 'Binding to `0.0.0.0` exposes the server to the whole network. If that\'s intended, say so in the PR description; otherwise default to `"127.0.0.1"` and make it configurable.',
    },
    {
      path: "src/server.ts",
      line: 5,
      severity: "nit",
      body: "`host` is declared but never passed to `app.listen`, so the bind address doesn't actually change yet.",
    },
  ],
};

function scriptedReview() {
  return () =>
    (async function* () {
      yield { type: "system", subtype: "init", mcp_servers: [{ name: "codebase-qa", status: "connected" }] };
      const calls = [
        ["get_pr", { pr: "acme/widgets#7" }],
        ["get_pr_diff", { pr: "acme/widgets#7" }],
        ["search_code", { query: "app.listen" }],
      ] as const;
      for (const [name, input] of calls) {
        await sleep(700);
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: name, name: `mcp__codebase-qa__${name}`, input }] } };
      }
      await sleep(900);
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0612, num_turns: 5, duration_ms: 14_200, structured_output: REVIEW };
    })() as any;
}

const gh = fakeGitHub();
// The fake records every request for tests; a long-running public demo keeps only recent ones.
const fetchGitHub: typeof gh.fetch = (url, init) => {
  if (gh.requests.length > 100) gh.requests.length = 0;
  return gh.fetch(url, init);
};
const github = new GitHubClient({ token: "demo", fetch: fetchGitHub });

// Visitors may open public GitHub repos to see the tools run on them. This uses the real,
// unauthenticated GitHub API (not the fake above, which serves only the sample PR), with
// the demo's tight limits: public repos only, small, one download at a time, no folders.
const repos = new RepoRegistry({ defaultRoot: root, policy: repoPolicyFromEnv("demo"), github: new GitHubClient() });
const mcp = await startHttpServer({ root, port: 0, github, rootFor: (id) => repos.rootFor(id) });
const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`, ...publicHosts];
if (bindHost !== "127.0.0.1" && bindHost !== "localhost" && publicHosts.length === 0) {
  console.error(`Listening on ${bindHost} but PUBLIC_HOSTS is empty, so only localhost requests will be answered.`);
}

createWebApp({
  root,
  model: "demo (scripted, no API calls)",
  github,
  canPost: true,
  maxBudgetUsd: 1,
  openTools: (repoId) => mcpToolProvider(repoId ? `${mcp.url}/${repoId}` : mcp.url),
  repos,
  mcp: { url: mcp.url },
  allowedHosts,
  demo: true,
  // Visitors share one instance; scripted runs are cheap, so allow a few at once.
  maxConcurrentRuns: 8,
  staticDir: path.resolve(root, "web/dist/web/browser"),
  anthropic: scriptedAnthropic(repos.defaultRepo().label) as any,
  reviewQuery: scriptedReview(),
}).listen(port, bindHost, () => {
  console.error(`Demo UI (scripted, no API key needed): http://localhost:${port}`);
  if (publicHosts.length) console.error(`Also answering to: ${publicHosts.join(", ")}`);
  console.error("Try the review with: acme/widgets#7");
  console.error("Ask about another codebase by entering a public GitHub repo, e.g. octocat/Hello-World");
});
