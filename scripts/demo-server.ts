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
const usage = { input_tokens: 2_400, output_tokens: 310 };

const ANSWER = `The review agent is read-only by construction, not by instruction. Three settings in \`buildReviewOptions\` do the work (\`src/review.ts:129\`):

1. **No built-in tools.** \`tools: []\` removes Claude Code's shell and file-editing tools entirely.
2. **An explicit allowlist.** \`allowedTools: REVIEW_TOOLS\` lists only \`get_pr\`, \`get_pr_diff\`, \`search_code\`, \`read_file\`, and \`search_docs\` (\`src/review.ts:19\`). \`post_review\` is deliberately absent.
3. **Deny by default.** \`permissionMode: "dontAsk"\` means anything outside the allowlist is refused rather than prompted.

It is also isolated from the machine it runs on: \`settingSources: []\` ignores local Claude settings, \`strictMcpConfig: true\` admits only this project's MCP server, and \`agentEnv()\` strips inherited Claude Code session variables.

Posting happens outside the agent. The review comes back as JSON, and the command (or the **Post to GitHub** button) publishes it with \`head_sha\`, so it is refused if the PR has new commits.`;

/** Scripted turns for the demo's own repository. Tool calls run for real against it. */
function builtInTurns(): any[] {
  return [
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
}

/**
 * Scripted turns for any other repository: a short tour whose tool calls run for real on
 * the chosen repo. The last turn is a template filled in from those tool results, and it
 * says so, since no model wrote it.
 */
function tourTurns(label: string, results: Map<string, string>): any[] {
  return [
    {
      stop_reason: "tool_use",
      usage,
      content: [
        { type: "text", text: "I'll start with the project's own documentation." },
        { type: "tool_use", id: "tour1", name: "search_docs", input: { query: "overview introduction getting started architecture", k: 3 } },
      ],
    },
    {
      stop_reason: "tool_use",
      usage,
      content: [{ type: "tool_use", id: "tour2", name: "read_file", input: { path: "README.md", start: 1, end: 80 } }],
    },
    {
      stop_reason: "tool_use",
      usage,
      content: [{ type: "tool_use", id: "tour3", name: "search_code", input: { query: "TODO", k: 5 } }],
    },
    { stop_reason: "end_turn", usage, content: [{ type: "text", text: tourAnswer(label, results) }] },
  ];
}

/** Fill in the tour's answer from what the tools actually returned. */
function tourAnswer(label: string, results: Map<string, string>): string {
  // README: its first heading and first prose paragraph (read_file lines look like "12  text").
  const readme = results.get("tour2") ?? "";
  let readmePart = "There's no `README.md` at the root of this repository.";
  if (!readme.startsWith("Error:")) {
    const lines = readme.split("\n").slice(1).map((l) => l.replace(/^\d+ {2}/, ""));
    const heading = lines.find((l) => /^#{1,6}\s/.test(l))?.replace(/^#+\s*/, "");
    const para: string[] = [];
    for (const l of lines) {
      if (para.length && !l.trim()) break;
      // Skip headings, badges and HTML; keep the first run of plain prose.
      if (l.trim() && !/^(#|\[!\[|<|!\[|---|===)/.test(l.trim())) para.push(l.trim());
    }
    const text = para.join(" ").slice(0, 400);
    readmePart = [heading && `**${heading}**`, text && `> ${text}${para.join(" ").length > 400 ? "…" : ""}`]
      .filter(Boolean)
      .join("\n\n") || "The README has no plain-text introduction.";
  }

  // search_docs hits look like "[1] docs/setup.md:12 — Installing (score 3.10)".
  const docs = [...(results.get("tour1") ?? "").matchAll(/^\[\d+\] (\S+:\d+) — (.*) \(score/gm)]
    .map((m) => `- \`${m[1]}\` ${m[2]}`);
  // search_code hits: a "path:line" line followed by context, the matching line marked ">".
  const todos = [...(results.get("tour3") ?? "").matchAll(/^(\S+:\d+)\n(?:.*\n)*?\d+> (.*)$/gm)]
    .map((m) => `- \`${m[1]}\` ${m[2].trim().slice(0, 120)}`);

  return [
    `> **Demo mode.** The steps beside this answer really ran against **${label}**, but this text is filled in from a template, not written by Claude. Run the app with your own API key (\`npm run web\`) for real answers to any question.`,
    "### From the README",
    readmePart,
    "### Documentation that matched an overview search",
    docs.length ? docs.join("\n") : "No Markdown documentation matched.",
    "### Open TODOs",
    todos.length ? todos.join("\n") : "No TODO comments turned up.",
  ].join("\n\n");
}

/**
 * A stand-in for the Anthropic client. It's stateless: like a real model, it decides its
 * next turn from the conversation it is sent, so concurrent visitors don't share a script.
 * Which repository is being asked about comes from the system prompt (see agent.ts).
 */
function scriptedAnthropic(builtInLabel: string) {
  return {
    messages: {
      create: async () => {
        throw new Error("demo streams only");
      },
      stream: (params: { system?: string; messages: Array<{ role: string; content: unknown }> }) => {
        const label = /The codebase you are answering about: (.+)$/.exec(params.system ?? "")?.[1] ?? builtInLabel;
        // Each earlier assistant message was one scripted turn.
        const turn = params.messages.filter((m) => m.role === "assistant").length;
        // Tool results so far, by tool_use id, for the tour's final answer.
        const results = new Map<string, string>();
        for (const m of params.messages) {
          if (!Array.isArray(m.content)) continue;
          for (const b of m.content as Array<{ type: string; tool_use_id?: string; content?: unknown }>) {
            if (b.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, String(b.content ?? ""));
          }
        }
        const script = label === builtInLabel ? builtInTurns() : tourTurns(label, results);
        const msg = script[Math.min(turn, script.length - 1)];
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
