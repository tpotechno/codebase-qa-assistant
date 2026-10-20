import { test } from "node:test";
import assert from "node:assert/strict";
import { agentEnv, buildReviewOptions, parseBudget, formatReviewMarkdown, REVIEW_TOOLS, runReview, type Review } from "../src/review.ts";

const ref = { owner: "acme", repo: "widgets", number: 7 };
const review: Review = {
  summary: "Makes the port configurable but drops the default.",
  verdict: "minor_issues",
  comments: [
    { path: "src/server.ts", line: 3, severity: "nit", body: "Name the constant." },
    { path: "src/server.ts", line: 2, severity: "blocker", body: "PORT may be unset; default to 3000." },
  ],
};

/** Replays a scripted Agent SDK message stream and records the options it was called with. */
function fakeQuery(messages: any[]) {
  const calls: any[] = [];
  const fn = (params: any) => {
    calls.push(params);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
  return { fn, calls };
}

const init = (status = "connected") => ({ type: "system", subtype: "init", mcp_servers: [{ name: "codebase-qa", status }] });
const toolUse = (name: string, input: unknown) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "x", name: `mcp__codebase-qa__${name}`, input }] },
});
const success = (structured_output: unknown) => ({
  type: "result", subtype: "success", total_cost_usd: 0.0421, num_turns: 6, duration_ms: 18_000, structured_output,
});

test("review agent is read-only, isolated, schema-bound, and budget-capped", () => {
  const o = buildReviewOptions({ mcpUrl: "http://127.0.0.1:1/mcp", mcpToken: "tok", maxBudgetUsd: 0.5 });
  assert.deepEqual(o.tools, []);
  assert.equal(o.permissionMode, "dontAsk");
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
  assert.equal(o.maxBudgetUsd, 0.5);
  assert.equal(o.outputFormat?.type, "json_schema");
  assert.deepEqual(o.allowedTools, REVIEW_TOOLS);
  assert.ok(!REVIEW_TOOLS.some((t) => t.includes("post_review")), "agent must not get the write tool");
  const server = o.mcpServers?.["codebase-qa"] as any;
  assert.equal(server.type, "http");
  assert.equal(server.headers.Authorization, "Bearer tok");
});

test("runReview returns the structured review, cost, and reports tool calls", async () => {
  const q = fakeQuery([init(), toolUse("get_pr", { pr: "acme/widgets#7" }), toolUse("get_pr_diff", { pr: "acme/widgets#7" }), success(review)]);
  const seen: string[] = [];
  const r = await runReview(ref, { mcpUrl: "http://x/mcp", queryFn: q.fn, onToolCall: (n) => seen.push(n) });
  assert.deepEqual(seen, ["get_pr", "get_pr_diff"]);
  assert.equal(r.costUsd, 0.0421);
  assert.equal(r.turns, 6);
  assert.deepEqual(r.review, review);
  assert.equal(q.calls[0].prompt, "Review pull request acme/widgets#7.");
});

test("runReview fails clearly on a disconnected MCP server, budget cap, or missing output", async () => {
  await assert.rejects(runReview(ref, { mcpUrl: "u", queryFn: fakeQuery([init("failed")]).fn }), /failed to connect/);
  await assert.rejects(
    runReview(ref, {
      mcpUrl: "u",
      maxBudgetUsd: 0.25,
      queryFn: fakeQuery([init(), { type: "result", subtype: "error_max_budget_usd", total_cost_usd: 0.25 }]).fn,
    }),
    /spend cap of \$0.25 reached/,
  );
  await assert.rejects(runReview(ref, { mcpUrl: "u", queryFn: fakeQuery([init(), success(undefined)]).fn }), /no structured review/);
  await assert.rejects(runReview(ref, { mcpUrl: "u", queryFn: fakeQuery([init()]).fn }), /without a result/);
  await assert.rejects(
    runReview(ref, {
      mcpUrl: "u",
      queryFn: fakeQuery([init(), { ...success(undefined), is_error: true, result: "Invalid API key · Fix external API key" }]).fn,
    }),
    /Review failed: Invalid API key/,
  );
});

test("formatReviewMarkdown orders by severity and can omit inline comments", () => {
  const md = formatReviewMarkdown(ref, review);
  assert.match(md, /\*\*Verdict:\*\* Minor issues \(1 blocker, 1 nit\)/);
  assert.ok(md.indexOf("blocker") < md.indexOf("**nit**"));
  assert.doesNotMatch(formatReviewMarkdown(ref, review, { includeInline: false }), /### Comments/);
});

test("agentEnv drops inherited Claude Code session variables but keeps the rest", () => {
  const env = agentEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_ENABLE_CFC: "1", CLAUDECODE: "1", CLAUDE_CHROME_PERMISSION_MODE: "ask" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.ANTHROPIC_API_KEY, "k");
  assert.equal(env.CLAUDE_CODE_ENABLE_CFC, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CHROME_PERMISSION_MODE, undefined);
  assert.match(env.CLAUDE_AGENT_SDK_CLIENT_APP!, /^codebase-qa-assistant/);
});

test("parseBudget defaults when unset or blank and rejects junk", () => {
  assert.equal(parseBudget(undefined), 1);
  assert.equal(parseBudget("  "), 1);
  assert.equal(parseBudget("0.5"), 0.5);
  for (const bad of ["abc", "0", "-1", "Infinity", "NaN"]) assert.throws(() => parseBudget(bad), /greater than 0/);
});
