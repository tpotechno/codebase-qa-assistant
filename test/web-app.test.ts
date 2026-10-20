import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createWebApp } from "../src/web-app.ts";
import { startHttpServer } from "../src/mcp-server.ts";
import { GitHubClient } from "../src/github.ts";
import { mcpToolProvider } from "../src/tool-provider.ts";
import { HEAD_SHA, fakeGitHub, type FakeGitHub } from "./fixtures/fake-github.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Fake Anthropic client whose stream() replays scripted turns, emitting text deltas. */
function fakeAnthropic(turns: any[]) {
  const next = () => {
    const t = turns.shift();
    if (!t) throw new Error("no scripted turn");
    return t;
  };
  return {
    messages: {
      create: async () => next(),
      stream: () => {
        const listeners: Array<(d: string) => void> = [];
        return {
          on(event: string, cb: (d: string) => void) {
            if (event === "text") listeners.push(cb);
            return this;
          },
          async finalMessage() {
            const msg = next();
            for (const b of msg.content) if (b.type === "text") for (const ch of b.text.match(/.{1,4}/gs) ?? []) listeners.forEach((l) => l(ch));
            return msg;
          },
        };
      },
    },
  };
}

const usage = { input_tokens: 5, output_tokens: 3 };
const review = {
  summary: "Drops the port default.",
  verdict: "minor_issues",
  comments: [{ path: "src/server.ts", line: 2, severity: "blocker", body: "Default to 3000 when PORT is unset." }],
};

function reviewQuery() {
  return () =>
    (async function* () {
      yield { type: "system", subtype: "init", mcp_servers: [{ name: "codebase-qa", status: "connected" }] };
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "mcp__codebase-qa__get_pr_diff", input: { pr: "acme/widgets#7" } }] } };
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.05, num_turns: 4, duration_ms: 9000, structured_output: review };
    })() as any;
}

let gh: FakeGitHub;
let mcp: Awaited<ReturnType<typeof startHttpServer>>;
let server: http.Server;
let base: string;
let anthropicTurns: any[];

async function startApp(overrides: Record<string, unknown> = {}) {
  const allowedHosts: string[] = [];
  const github = new GitHubClient({ token: "t", fetch: gh.fetch });
  const app = createWebApp({
    root,
    model: "test-model",
    github,
    canPost: true,
    maxBudgetUsd: 1,
    openTools: () => mcpToolProvider(mcp.url),
    mcp: { url: mcp.url },
    allowedHosts,
    anthropic: fakeAnthropic(anthropicTurns) as any,
    reviewQuery: reviewQuery(),
    ...overrides,
  });
  const s = await new Promise<http.Server>((r) => {
    const srv = app.listen(0, "127.0.0.1", () => r(srv));
  });
  const port = (s.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  return { server: s, base: `http://127.0.0.1:${port}` };
}

before(async () => {
  gh = fakeGitHub();
  mcp = await startHttpServer({ root, port: 0, github: new GitHubClient({ fetch: gh.fetch }) });
  anthropicTurns = [];
  ({ server, base } = await startApp());
});
after(() => {
  server.close();
  mcp.server.close();
});

/** POST JSON and parse the SSE response into events. */
async function sse(pathname: string, body: unknown) {
  const res = await fetch(base + pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const event = /^event: (.*)$/m.exec(frame)![1];
      const data = JSON.parse(/^data: (.*)$/m.exec(frame)![1]);
      return { event, data };
    });
}

const postJson = (pathname: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + pathname, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("GET /api/config describes the repo, model, and posting ability", async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.repoName, path.basename(root));
  assert.equal(cfg.model, "test-model");
  assert.equal(cfg.canPost, true);
});

test("POST /api/ask streams tool calls, results, text by turn, and a final answer", async () => {
  anthropicTurns.push(
    { stop_reason: "tool_use", usage, content: [{ type: "text", text: "Checking the PR." }, { type: "tool_use", id: "t1", name: "get_pr", input: { pr: "acme/widgets#7" } }] },
    { stop_reason: "end_turn", usage, content: [{ type: "text", text: "It reads the port from PORT." }] },
  );
  const events = await sse("/api/ask", { question: "What does PR 7 change?" });
  const kinds = events.map((e) => e.event);
  assert.deepEqual([...new Set(kinds)], ["text", "tool_call", "tool_result", "done"]);

  const call = events.find((e) => e.event === "tool_call")!.data;
  const result = events.find((e) => e.event === "tool_result")!.data;
  assert.equal(call.name, "get_pr");
  assert.equal(result.id, call.id);
  assert.equal(result.isError, false);
  assert.match(result.preview, /Read port from environment/, "ask can use the PR tools through MCP");

  const turn2 = events.filter((e) => e.event === "text" && e.data.turn === 2).map((e) => e.data.delta).join("");
  assert.equal(turn2, "It reads the port from PORT.");
  const done = events.at(-1)!;
  assert.equal(done.data.answer, "It reads the port from PORT.");
  assert.equal(done.data.turns, 2);
});

test("POST /api/ask rejects an empty question", async () => {
  const res = await postJson("/api/ask", { question: "   " });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /question/);
});

test("POST /api/review streams started, tool calls, and the structured review", async () => {
  const events = await sse("/api/review", { pr: "acme/widgets#7" });
  assert.deepEqual(events.map((e) => e.event), ["started", "tool_call", "done"]);
  assert.equal(events[0].data.headSha, HEAD_SHA);
  assert.equal(events[0].data.title, "Read port from environment");
  assert.equal(events[1].data.name, "get_pr_diff");
  assert.deepEqual(events[2].data.review, review);
  assert.equal(events[2].data.headSha, HEAD_SHA);
});

test("POST /api/review reports bad and missing PRs", async () => {
  const bad = await postJson("/api/review", { pr: "../..#1" });
  assert.equal(bad.status, 400);
  const missing = await sse("/api/review", { pr: "acme/widgets#99" });
  assert.equal(missing[0].event, "error");
  assert.match(missing[0].data.message, /GitHub 404/);
});

test("POST /api/review/post publishes the exact draft as a COMMENT", async () => {
  const res = await postJson("/api/review/post", { pr: "acme/widgets#7", headSha: HEAD_SHA, review });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).inlineCount, 1);
  const sent = gh.requests.filter((r) => r.method === "POST").at(-1)!.body;
  assert.equal(sent.event, "COMMENT");
  assert.equal(sent.comments[0].body, "**blocker:** Default to 3000 when PORT is unset.");
});

test("POST /api/review/post refuses stale commits, bad input, and missing tokens", async () => {
  const stale = await postJson("/api/review/post", { pr: "acme/widgets#7", headSha: "f".repeat(40), review });
  assert.equal(stale.status, 409);
  const invalid = await postJson("/api/review/post", { pr: "acme/widgets#7", headSha: "nope", review });
  assert.equal(invalid.status, 400);

  const noToken = await startApp({ canPost: false });
  try {
    const r = await fetch(`${noToken.base}/api/review/post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pr: "acme/widgets#7", headSha: HEAD_SHA, review }),
    });
    assert.equal(r.status, 403);
  } finally {
    noToken.server.close();
  }
});

test("cross-site requests are rejected: foreign Origin, non-JSON body, foreign Host", async () => {
  const foreign = await postJson("/api/ask", { question: "hi" }, { Origin: "https://evil.example" });
  assert.equal(foreign.status, 403);

  const form = await fetch(`${base}/api/ask`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "question=hi" });
  assert.equal(form.status, 415);

  const status = await new Promise<number>((resolve, reject) => {
    const u = new URL(`${base}/api/config`);
    http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: "attacker.example:80" } }, (r) => {
      r.resume();
      resolve(r.statusCode!);
    }).on("error", reject);
  });
  assert.equal(status, 403);
});
