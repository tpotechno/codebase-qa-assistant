import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "../src/mcp-server.ts";
import { mcpToolProvider, type ToolProvider } from "../src/tool-provider.ts";
import { runAgent } from "../src/agent.ts";
import { GitHubClient } from "../src/github.ts";
import { fakeGitHub } from "./fixtures/fake-github.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "test-token-123";

let server: Server;
let url: string;
let tools: ToolProvider;

before(async () => {
  ({ server, url } = await startHttpServer({ root, port: 0, token: TOKEN, github: new GitHubClient({ fetch: fakeGitHub().fetch }) }));
  tools = await mcpToolProvider(url, TOKEN);
});

after(async () => {
  await tools.close();
  await new Promise((r) => server.close(r));
});

test("lists the repo and PR tools with JSON schemas (post_review off by default)", async () => {
  const list = await tools.listTools();
  assert.deepEqual(list.map((t) => t.name).sort(), ["get_pr", "get_pr_diff", "read_file", "search_code", "search_docs"]);
  const read = list.find((t) => t.name === "read_file")!;
  assert.equal(read.input_schema.type, "object");
  assert.deepEqual(read.input_schema.required, ["path"]);
});

test("search_code and search_docs work over HTTP", async () => {
  const code = await tools.callTool("search_code", { query: "registerTool", k: 1 });
  assert.equal(code.isError, false);
  assert.match(code.content, /src\/mcp-server\.ts:\d+/);

  const docs = await tools.callTool("search_docs", { query: "roadmap MCP server" });
  assert.equal(docs.isError, false);
  assert.match(docs.content, /README\.md:\d+/);
});

test("path traversal is refused and flagged as an error", async () => {
  const r = await tools.callTool("read_file", { path: "../../etc/passwd" });
  assert.equal(r.isError, true);
  assert.match(r.content, /outside the repository root/);
});

test("invalid arguments are rejected by schema validation", async () => {
  const r = await tools.callTool("search_code", { query: "" });
  assert.equal(r.isError, true);
});

test("requests without the bearer token are rejected", async () => {
  await assert.rejects(mcpToolProvider(url));
  await assert.rejects(mcpToolProvider(url, "wrong-token"));
});

test("health endpoint responds without auth", async () => {
  const res = await fetch(url.replace(/\/mcp$/, "/health"));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, "codebase-qa");
});

test("agent loop runs end-to-end against the MCP server", async () => {
  const responses: any[] = [
    {
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", id: "t1", name: "search_docs", input: { query: "phase 2 MCP" } }],
    },
    { stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "done" }] },
  ];
  const requests: any[] = [];
  const client = { messages: { create: async (req: any) => (requests.push(structuredClone(req)), responses.shift()) } };

  const result = await runAgent("What is Phase 2?", { client: client as any, tools });
  assert.equal(result.answer, "done");
  // Tools sent to Claude were discovered from the MCP server.
  assert.ok(requests[0].tools.some((t: any) => t.name === "search_docs"));
  const toolResult = requests[1].messages.at(-1).content[0];
  assert.equal(toolResult.is_error, false);
  assert.match(toolResult.content, /README\.md/);
});

test("get_pr and get_pr_diff work over HTTP", async () => {
  const pr = await tools.callTool("get_pr", { pr: "acme/widgets#7" });
  assert.equal(pr.isError, false);
  assert.match(pr.content, /Read port from environment/);

  const diff = await tools.callTool("get_pr_diff", { pr: "https://github.com/acme/widgets/pull/7" });
  assert.match(diff.content, /Page 1 of 1/);
  assert.match(diff.content, /2 \+ const port = Number/);

  const missing = await tools.callTool("get_pr", { pr: "acme/widgets#99" });
  assert.equal(missing.isError, true);
  assert.match(missing.content, /GitHub 404/);
});

test("post_review is only registered with allowPost and a token, and posts a COMMENT", async () => {
  const gh = fakeGitHub();
  const noToken = await startHttpServer({ root, port: 0, allowPost: true, github: new GitHubClient({ fetch: gh.fetch }) });
  const withToken = await startHttpServer({ root, port: 0, allowPost: true, github: new GitHubClient({ token: "t", fetch: gh.fetch }) });
  const a = await mcpToolProvider(noToken.url);
  const b = await mcpToolProvider(withToken.url);
  try {
    assert.ok(!(await a.listTools()).some((t) => t.name === "post_review"));
    assert.ok((await b.listTools()).some((t) => t.name === "post_review"));
    const r = await b.callTool("post_review", {
      pr: "acme/widgets#7",
      body: "Looks fine.",
      comments: [{ path: "src/server.ts", line: 2, body: "Default the port." }],
    });
    assert.equal(r.isError, false);
    assert.match(r.content, /1 inline comment\(s\), 0 moved/);
    assert.equal(gh.requests.find((x) => x.method === "POST")!.body.event, "COMMENT");
  } finally {
    await a.close();
    await b.close();
    noToken.server.close();
    withToken.server.close();
  }
});
