/**
 * Runs the web UI with a scripted stand-in for Claude, so the interface can be developed,
 * demoed, and screenshotted without an API key or any spend.
 *
 *   npm run web:build && npm run web:demo   ->  http://localhost:3335
 *
 * The repo tools are real (they read this repository through the real MCP server); only the
 * model's decisions and words are scripted. The review uses a sample pull request
 * (acme/widgets#7) served by an in-memory GitHub, so nothing touches github.com.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "../src/mcp-server.ts";
import { GitHubClient } from "../src/github.ts";
import { mcpToolProvider } from "../src/tool-provider.ts";
import { createWebApp } from "../src/web-app.ts";
import { fakeGitHub } from "../test/fixtures/fake-github.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const port = Number(process.env.DEMO_PORT ?? 3335);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usage = { input_tokens: 2_400, output_tokens: 310 };

const ANSWER = `The review agent is read-only by construction, not by instruction. Three settings in \`buildReviewOptions\` do the work (\`src/review.ts:129\`):

1. **No built-in tools.** \`tools: []\` removes Claude Code's shell and file-editing tools entirely.
2. **An explicit allowlist.** \`allowedTools: REVIEW_TOOLS\` lists only \`get_pr\`, \`get_pr_diff\`, \`search_code\`, \`read_file\`, and \`search_docs\` (\`src/review.ts:19\`). \`post_review\` is deliberately absent.
3. **Deny by default.** \`permissionMode: "dontAsk"\` means anything outside the allowlist is refused rather than prompted.

It is also isolated from the machine it runs on: \`settingSources: []\` ignores local Claude settings, \`strictMcpConfig: true\` admits only this project's MCP server, and \`agentEnv()\` strips inherited Claude Code session variables.

Posting happens outside the agent. The review comes back as JSON, and the command (or the **Post to GitHub** button) publishes it with \`head_sha\`, so it is refused if the PR has new commits.`;

/** Scripted turns for /api/ask. Tool calls run for real against this repo. */
function scriptedAnthropic() {
  let turns: any[] = [];
  const reset = () => {
    turns = [
      {
        stop_reason: "tool_use",
        usage,
        content: [
          { type: "text", text: "I'll find where the review agent's permissions are configured." },
          { type: "tool_use", id: "t1", name: "search_code", input: { query: "allowedTools", k: 5 } },
        ],
      },
      {
        stop_reason: "tool_use",
        usage,
        content: [{ type: "tool_use", id: "t2", name: "read_file", input: { path: "src/review.ts", start: 129, end: 160 } }],
      },
      {
        stop_reason: "tool_use",
        usage,
        content: [{ type: "tool_use", id: "t3", name: "search_docs", input: { query: "agent never gets the write tool" } }],
      },
      { stop_reason: "end_turn", usage, content: [{ type: "text", text: ANSWER }] },
    ];
  };
  return {
    messages: {
      create: async () => {
        throw new Error("demo streams only");
      },
      stream: () => {
        if (!turns.length) reset();
        const msg = turns.shift();
        const listeners: Array<(d: string) => void> = [];
        return {
          on(event: string, cb: (d: string) => void) {
            if (event === "text") listeners.push(cb);
            return this;
          },
          async finalMessage() {
            await sleep(500);
            for (const block of msg.content) {
              if (block.type !== "text") continue;
              for (const piece of block.text.match(/[\s\S]{1,6}/g) ?? []) {
                listeners.forEach((l) => l(piece));
                await sleep(12);
              }
            }
            return msg;
          },
        };
      },
    },
  };
}

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
const github = new GitHubClient({ token: "demo", fetch: gh.fetch });
const mcp = await startHttpServer({ root, port: 0, github });
const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];

createWebApp({
  root,
  model: "demo (scripted, no API calls)",
  github,
  canPost: true,
  maxBudgetUsd: 1,
  openTools: () => mcpToolProvider(mcp.url),
  mcp: { url: mcp.url },
  allowedHosts,
  staticDir: path.resolve(root, "web/dist/web/browser"),
  anthropic: scriptedAnthropic() as any,
  reviewQuery: scriptedReview(),
}).listen(port, "127.0.0.1", () => {
  console.error(`Demo UI (scripted, no API key needed): http://localhost:${port}`);
  console.error("Try the review with: acme/widgets#7");
});
