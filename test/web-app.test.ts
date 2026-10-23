import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { DraftStore, createWebApp, parseList, parsePort } from "../src/web-app.ts";
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
  assert.equal(cfg.demo, false);
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
  assert.match(events[2].data.draftId, /^[0-9a-f-]{36}$/);
});

test("POST /api/review reports bad and missing PRs", async () => {
  const bad = await postJson("/api/review", { pr: "../..#1" });
  assert.equal(bad.status, 400);
  const missing = await sse("/api/review", { pr: "acme/widgets#99" });
  assert.equal(missing[0].event, "error");
  assert.match(missing[0].data.message, /GitHub 404/);
});

/** Run a review through the API and return the draft id the server issued. */
async function reviewDraftId(): Promise<string> {
  const events = await sse("/api/review", { pr: "acme/widgets#7" });
  return events.find((e) => e.event === "done")!.data.draftId;
}

test("POST /api/review/post publishes the server's draft as a COMMENT, exactly once", async () => {
  const draftId = await reviewDraftId();
  const res = await postJson("/api/review/post", { draftId });
  assert.equal(res.status, 200);
  const posted = await res.json();
  assert.equal(posted.inlineCount, 1);
  const sent = gh.requests.filter((r) => r.method === "POST").at(-1)!.body;
  assert.equal(sent.event, "COMMENT");
  assert.equal(sent.comments[0].body, "**blocker:** Default to 3000 when PORT is unset.");

  const again = await postJson("/api/review/post", { draftId });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, new RegExp(`already posted: ${posted.url.replace(/[.#]/g, "\\$&")}`));
});

test("two simultaneous posts of one draft publish once", async () => {
  const draftId = await reviewDraftId();
  const before = gh.requests.filter((r) => r.method === "POST").length;
  const [a, b] = await Promise.all([postJson("/api/review/post", { draftId }), postJson("/api/review/post", { draftId })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(gh.requests.filter((r) => r.method === "POST").length, before + 1);
});

test("only drafts the server produced can be posted; client-supplied review text is rejected", async () => {
  const unknown = await postJson("/api/review/post", { draftId: "00000000-0000-4000-8000-000000000000" });
  assert.equal(unknown.status, 404);
  const forged = await postJson("/api/review/post", { pr: "acme/widgets#7", headSha: HEAD_SHA, review });
  assert.equal(forged.status, 400);
});

test("posting refuses a stale commit (typed 409) and leaves the draft retryable; no token means 403", async () => {
  const drafts = new DraftStore();
  const app = await startApp({ drafts });
  try {
    const staleId = drafts.add({ owner: "acme", repo: "widgets", number: 7 }, "f".repeat(40), review as any);
    const post = () =>
      fetch(`${app.base}/api/review/post`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId: staleId }) });
    const r1 = await post();
    assert.equal(r1.status, 409);
    assert.match((await r1.json()).error, /new commits since it was reviewed/);
    assert.equal((await post()).status, 409, "still refused for the same reason, not 'already posting'");
  } finally {
    app.server.close();
  }

  const noToken = await startApp({ canPost: false });
  try {
    const r = await fetch(`${noToken.base}/api/review/post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId: "00000000-0000-4000-8000-000000000000" }),
    });
    assert.equal(r.status, 403);
  } finally {
    noToken.server.close();
  }
});

test("DraftStore expires old drafts and keeps a bounded number", async () => {
  const ref = { owner: "acme", repo: "widgets", number: 7 };
  const expiring = new DraftStore(1);
  const id = expiring.add(ref, HEAD_SHA, review as any);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(expiring.get(id), undefined);

  const bounded = new DraftStore(60_000, 3);
  const ids = Array.from({ length: 5 }, () => bounded.add(ref, HEAD_SHA, review as any));
  assert.equal(bounded.get(ids[0]), undefined, "oldest evicted");
  assert.ok(bounded.get(ids[4]));
});

test("a run that stalls is cancelled after the timeout and frees its slot", async () => {
  const hung = () =>
    (async function* () {
      yield { type: "system", subtype: "init", mcp_servers: [{ name: "codebase-qa", status: "connected" }] };
      await new Promise(() => {}); // never finishes
    })() as any;
  const app = await startApp({ runTimeoutMs: 150, reviewQuery: hung, maxConcurrentRuns: 1 });
  try {
    const run = async () => {
      const res = await fetch(`${app.base}/api/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pr: "acme/widgets#7" }) });
      return res.text();
    };
    assert.match(await run(), /event: error\ndata: \{"message":"Stopped: no result after 1 seconds/);
    assert.match(await run(), /event: started/, "the slot was released, so a second run can start");
  } finally {
    app.server.close();
  }
});

test("each review fetches the PR fresh, even right after another", async () => {
  const prFetches = () => gh.requests.filter((r) => r.method === "GET" && /\/pulls\/7$/.test(r.path)).length;
  await sse("/api/review", { pr: "acme/widgets#7" });
  const before = prFetches();
  await sse("/api/review", { pr: "acme/widgets#7" });
  assert.equal(prFetches(), before + 1, "not served from the 60s cache");
});

test("DraftStore never evicts a draft that is being posted", () => {
  const ref = { owner: "acme", repo: "widgets", number: 7 };
  const store = new DraftStore(60_000, 2);
  const a = store.add(ref, HEAD_SHA, review as any);
  store.get(a)!.state = "posting";
  const b = store.add(ref, HEAD_SHA, review as any);
  const c = store.add(ref, HEAD_SHA, review as any);
  assert.ok(store.get(a), "mid-post draft kept");
  assert.equal(store.get(b), undefined, "oldest idle draft evicted instead");
  assert.ok(store.get(c));
});

test("parsePort accepts valid ports and rejects junk", () => {
  assert.equal(parsePort(undefined, 3334), 3334);
  assert.equal(parsePort(" ", 3334), 3334);
  assert.equal(parsePort("8080", 3334), 8080);
  for (const bad of ["abc", "0", "65536", "80.5", "-1"]) assert.throws(() => parsePort(bad, 3334), /1 to 65535/);
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

test("/healthz answers platform probes from any Host; every response carries hardening headers", async () => {
  const probe = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const u = new URL(`${base}/healthz`);
    http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: "10.0.0.5:3335" } }, (r) => {
      r.resume();
      resolve({ status: r.statusCode!, headers: r.headers });
    }).on("error", reject);
  });
  assert.equal(probe.status, 200);
  assert.equal(probe.headers["x-content-type-options"], "nosniff");

  const cfg = await fetch(`${base}/api/config`);
  assert.equal(cfg.headers.get("x-frame-options"), "DENY");
  assert.equal(cfg.headers.get("referrer-policy"), "no-referrer");
});

test("hosted mode admits only allowlisted GitHub users signed in by the platform", async () => {
  const hosted = await startApp({ allowedUsers: ["tpotechno"] });
  try {
    const get = (headers: Record<string, string> = {}) => fetch(`${hosted.base}/api/config`, { headers });
    assert.equal((await get()).status, 401, "no identity: not signed in");
    assert.equal((await get({ "X-MS-CLIENT-PRINCIPAL-NAME": "someone", "X-MS-CLIENT-PRINCIPAL-IDP": "github" })).status, 403);
    assert.equal((await get({ "X-MS-CLIENT-PRINCIPAL-NAME": "tpotechno", "X-MS-CLIENT-PRINCIPAL-IDP": "aad" })).status, 403, "right name, wrong provider");

    const ok = await get({ "X-MS-CLIENT-PRINCIPAL-NAME": "TPOtechno", "X-MS-CLIENT-PRINCIPAL-IDP": "github" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).user, "TPOtechno");

    const principal = (auth_typ: string) => Buffer.from(JSON.stringify({ auth_typ, claims: [] })).toString("base64");
    assert.equal((await get({ "X-MS-CLIENT-PRINCIPAL-NAME": "tpotechno", "X-MS-CLIENT-PRINCIPAL": principal("github") })).status, 200, "provider read from the encoded principal");
    assert.equal((await get({ "X-MS-CLIENT-PRINCIPAL-NAME": "tpotechno", "X-MS-CLIENT-PRINCIPAL": principal("aad") })).status, 403);
    assert.equal((await get({ "X-MS-CLIENT-PRINCIPAL-NAME": "tpotechno", "X-MS-CLIENT-PRINCIPAL": "not base64 json" })).status, 403);

    const anon = await fetch(`${hosted.base}/api/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "hi" }) });
    assert.equal(anon.status, 401, "API calls are gated too");
    assert.equal((await fetch(`${hosted.base}/healthz`)).status, 200, "probes need no sign-in");
  } finally {
    hosted.server.close();
  }
  const local = await (await fetch(`${base}/api/config`)).json();
  assert.equal(local.user, null, "local use has no sign-in");
});

test("parseList trims and drops blanks", () => {
  assert.deepEqual(parseList(" a, b ,,c "), ["a", "b", "c"]);
  assert.deepEqual(parseList(undefined), []);
});
