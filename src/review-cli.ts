import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { startHttpServer } from "./mcp-server.ts";
import { GitHubClient, formatPrRef } from "./github.ts";
import { mcpToolProvider } from "./tool-provider.ts";
import { repoRoot } from "./tools.ts";
import { formatReviewMarkdown, inlineCommentBody, parseBudget, runReview } from "./review.ts";
import { USAGE, UsageError, parseReviewArgs, preparePost, type ReviewArgs } from "./review-cli-lib.ts";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

let args: ReviewArgs;
let maxBudgetUsd: number;
try {
  args = parseReviewArgs(process.argv.slice(2));
  maxBudgetUsd = parseBudget(process.env.REVIEW_MAX_BUDGET_USD);
} catch (e) {
  fail(e instanceof UsageError ? `${e.message}\n\n${USAGE}` : (e as Error).message);
}
const { ref, post, outFile } = args!;

if (!process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
const githubToken = process.env.GITHUB_TOKEN || undefined;
if (post && !githubToken) fail("--post needs GITHUB_TOKEN in .env (fine-grained token with Pull requests: read and write).");

// Use the configured MCP server, or start a private one in-process on a random port
// with a one-time token, so a review works from a single terminal. Its PR cache lasts
// longer than a review, so the agent sees one snapshot of the PR from start to finish.
let mcpUrl = process.env.MCP_SERVER_URL;
let mcpToken = process.env.MCP_AUTH_TOKEN || undefined;
let embedded: Awaited<ReturnType<typeof startHttpServer>> | undefined;
if (!mcpUrl) {
  mcpToken = randomBytes(24).toString("hex");
  embedded = await startHttpServer({
    root: repoRoot(),
    port: 0,
    token: mcpToken,
    github: new GitHubClient({ token: githubToken, cacheTtlMs: 10 * 60_000 }),
    allowPost: post,
  });
  mcpUrl = embedded.url;
}
const closeEmbedded = () => {
  embedded?.server.closeAllConnections();
  embedded?.server.close();
};

// Before paying for a review with --post: confirm posting will work and record the head commit.
let headSha: string | undefined;
if (post) {
  try {
    const probe = await mcpToolProvider(mcpUrl, mcpToken);
    try {
      ({ headSha } = await preparePost(probe, ref, mcpUrl));
    } finally {
      await probe.close();
    }
  } catch (e) {
    closeEmbedded();
    fail(`Not starting the review: ${(e as Error).message}`);
  }
}

console.error(`Reviewing ${formatPrRef(ref)} (tools: ${embedded ? "embedded MCP server" : mcpUrl})\n`);

try {
  const result = await runReview(ref, {
    mcpUrl,
    mcpToken,
    maxBudgetUsd: maxBudgetUsd!,
    onToolCall: (name, input) => console.error(`  ↳ ${name} ${JSON.stringify(input)}`),
  });

  const markdown = formatReviewMarkdown(ref, result.review);
  console.log(`\n${markdown}\n`);
  console.error(
    `[${result.turns} turn(s), $${result.costUsd.toFixed(4)}, ${(result.durationMs / 1000).toFixed(1)}s]`,
  );

  if (outFile) {
    await fs.writeFile(outFile, `${markdown}\n`, "utf8");
    console.error(`Saved to ${outFile}`);
  }

  if (post) {
    // Publishing is a deliberate, separate step: the agent never had the write tool.
    const tools = await mcpToolProvider(mcpUrl, mcpToken);
    try {
      const r = await tools.callTool("post_review", {
        pr: formatPrRef(ref),
        body: formatReviewMarkdown(ref, result.review, { includeInline: false }),
        comments: result.review.comments.map((c) => ({ path: c.path, line: c.line, body: inlineCommentBody(c) })),
        head_sha: headSha,
      });
      if (r.isError) throw new Error(r.content);
      console.error(r.content);
    } finally {
      await tools.close();
    }
  } else {
    console.error("Draft only. Re-run with --post to publish it to GitHub.");
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  closeEmbedded();
}
