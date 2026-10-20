import { query as agentQuery, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { formatPrRef, type PrRef } from "./github.ts";

/**
 * PR review agent, orchestrated by the Claude Agent SDK.
 *
 * Compared with the hand-written loop in agent.ts, the SDK owns the tool loop, context
 * management, MCP connection, permissions, turn limits, and cost tracking. This module
 * only supplies the task, the tool allowlist, and the shape of the answer.
 *
 * Safety: the agent gets read-only tools. It returns a structured review; publishing it
 * is a separate step the user triggers explicitly (review-cli --post).
 */

export const MCP_SERVER_KEY = "codebase-qa";
const mcpTool = (name: string) => `mcp__${MCP_SERVER_KEY}__${name}`;

/** The only tools the review agent may call. post_review is deliberately absent. */
export const REVIEW_TOOLS = ["get_pr", "get_pr_diff", "search_code", "read_file", "search_docs"].map(mcpTool);

export type Severity = "blocker" | "suggestion" | "nit";
export type Verdict = "looks_good" | "minor_issues" | "needs_changes";

export interface DraftComment {
  path: string;
  line: number;
  severity: Severity;
  body: string;
}

export interface Review {
  summary: string;
  verdict: Verdict;
  comments: DraftComment[];
}

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "verdict", "comments"],
  properties: {
    summary: { type: "string", description: "2-5 sentence overall assessment of the PR." },
    verdict: { type: "string", enum: ["looks_good", "minor_issues", "needs_changes"] },
    comments: {
      type: "array",
      maxItems: 25,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "line", "severity", "body"],
        properties: {
          path: { type: "string", description: "Changed file path exactly as shown in the diff." },
          line: { type: "integer", description: "New-file line number from the get_pr_diff gutter." },
          severity: { type: "string", enum: ["blocker", "suggestion", "nit"] },
          body: { type: "string", description: "The comment: what is wrong, why it matters, and a fix." },
        },
      },
    },
  },
} as const;

export const REVIEW_SYSTEM_PROMPT = `You are a senior software engineer reviewing a GitHub pull request.

Process:
1. Call get_pr to understand the intent and the changed files.
2. Call get_pr_diff and read every page (or each file with path=) before judging.
3. When a change depends on code outside the diff, use search_code, read_file, and search_docs.
   The local repository may be the same project at a different revision; use it for context only.

What to look for, in priority order: correctness bugs, security issues, error handling and edge
cases, missing or weak tests, then maintainability and clarity. Skip pure style preferences unless
they hurt readability.

Comments:
- Anchor each comment to a numbered line from the get_pr_diff gutter (new-file line numbers).
- Be specific and actionable: state the problem, why it matters, and a concrete fix.
- severity: "blocker" = must fix before merge; "suggestion" = worth doing; "nit" = optional polish.
- Prefer a few high-value comments over many trivial ones. An empty list is fine for a clean PR.
- Never invent problems you cannot point to in the code.`;

export interface ReviewOptions {
  /** URL of the MCP server providing the tools (Streamable HTTP). */
  mcpUrl: string;
  mcpToken?: string;
  model?: string;
  maxTurns?: number;
  /** Hard spend cap for this review, enforced by the Agent SDK. */
  maxBudgetUsd?: number;
  /** Progress callback for tool calls (name without the mcp__ prefix). */
  onToolCall?: (name: string, input: unknown) => void;
  /** Injectable for tests. */
  queryFn?: (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;
}

export interface ReviewResult {
  review: Review;
  costUsd: number;
  turns: number;
  durationMs: number;
}

/**
 * Environment for the Agent SDK subprocess. Variables inherited from a parent Claude Code
 * session (e.g. running this from Claude Code's terminal) can switch on extra tools or
 * integrations, so they are dropped; everything else (PATH, API key, proxies) passes through.
 */
export function agentEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) {
    if (/^(CLAUDE_CODE_|CLAUDE_CHROME|CLAUDECODE$|CCR_)/.test(k)) continue;
    env[k] = v;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "codebase-qa-assistant/0.3.0";
  return env;
}

export function buildReviewOptions(opts: ReviewOptions): Options {
  return {
    model: opts.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5",
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    mcpServers: {
      [MCP_SERVER_KEY]: {
        type: "http",
        url: opts.mcpUrl,
        headers: opts.mcpToken ? { Authorization: `Bearer ${opts.mcpToken}` } : undefined,
        alwaysLoad: true,
      },
    },
    tools: [], // no built-in Claude Code tools (no shell, no file edits)
    allowedTools: REVIEW_TOOLS,
    permissionMode: "dontAsk", // anything not in allowedTools is denied, never prompted
    settingSources: [], // ignore ~/.claude and project settings: reproducible runs
    strictMcpConfig: true, // only our MCP server; ignore any other MCP config on the machine
    env: agentEnv(),
    outputFormat: { type: "json_schema", schema: REVIEW_SCHEMA as unknown as Record<string, unknown> },
    maxTurns: opts.maxTurns ?? 30,
    maxBudgetUsd: opts.maxBudgetUsd ?? 1,
  };
}

export async function runReview(ref: PrRef, opts: ReviewOptions): Promise<ReviewResult> {
  const queryFn = opts.queryFn ?? agentQuery;
  const prompt = `Review pull request ${formatPrRef(ref)}.`;
  const prefix = `mcp__${MCP_SERVER_KEY}__`;

  for await (const msg of queryFn({ prompt, options: buildReviewOptions(opts) })) {
    if (msg.type === "system" && msg.subtype === "init") {
      const server = msg.mcp_servers.find((s) => s.name === MCP_SERVER_KEY);
      if (server && server.status !== "connected") {
        throw new Error(`MCP server "${MCP_SERVER_KEY}" failed to connect (status: ${server.status}).`);
      }
    } else if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "tool_use") opts.onToolCall?.(block.name.replace(prefix, ""), block.input);
      }
    } else if (msg.type === "result") {
      if (msg.subtype !== "success") {
        const why =
          msg.subtype === "error_max_budget_usd" ? `spend cap of $${opts.maxBudgetUsd ?? 1} reached`
          : msg.subtype === "error_max_turns" ? "turn limit reached"
          : msg.subtype === "error_max_structured_output_retries" ? "the model did not produce a valid review"
          : "the agent hit an error";
        throw new Error(`Review failed: ${why} (cost so far $${msg.total_cost_usd.toFixed(4)}).`);
      }
      if (msg.is_error) {
        // e.g. an invalid API key: the SDK reports subtype "success" with is_error and a message.
        throw new Error(`Review failed: ${msg.result || "the agent reported an error"}`);
      }
      const review = msg.structured_output as Review | undefined;
      if (!review || !Array.isArray(review.comments)) {
        throw new Error("Review failed: no structured review was returned.");
      }
      return { review, costUsd: msg.total_cost_usd, turns: msg.num_turns, durationMs: msg.duration_ms };
    }
  }
  throw new Error("Review failed: the agent ended without a result.");
}

const VERDICT_LABEL: Record<Verdict, string> = {
  looks_good: "Looks good",
  minor_issues: "Minor issues",
  needs_changes: "Needs changes",
};
const SEVERITY_ORDER: Severity[] = ["blocker", "suggestion", "nit"];

/** Human-readable review; also used as the body when posting to GitHub. */
export function formatReviewMarkdown(ref: PrRef, review: Review, opts: { includeInline?: boolean } = {}): string {
  const counts = SEVERITY_ORDER.map((s) => [s, review.comments.filter((c) => c.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}${n === 1 ? "" : "s"}`)
    .join(", ");
  const lines = [
    `## AI review: ${formatPrRef(ref)}`,
    "",
    `**Verdict:** ${VERDICT_LABEL[review.verdict] ?? review.verdict}${counts ? ` (${counts})` : ""}`,
    "",
    review.summary,
  ];
  if (opts.includeInline !== false && review.comments.length) {
    lines.push("", "### Comments");
    const sorted = [...review.comments].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );
    for (const c of sorted) lines.push("", `- **${c.severity}** \`${c.path}:${c.line}\` — ${c.body}`);
  }
  lines.push("", "<sub>Generated by codebase-qa-assistant (Claude Agent SDK + MCP). Advisory only.</sub>");
  return lines.join("\n");
}

/** Inline comment text as it appears on GitHub. */
export const inlineCommentBody = (c: DraftComment) => `**${c.severity}:** ${c.body}`;
