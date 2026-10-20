import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { startHttpServer } from "./mcp-server.ts";
import { GitHubClient, parsePrRef, formatPrRef } from "./github.ts";
import { mcpToolProvider } from "./tool-provider.ts";
import { repoRoot } from "./tools.ts";
import { formatReviewMarkdown, inlineCommentBody, parseBudget, runReview } from "./review.ts";

const USAGE = `Usage: npm run review -- <owner/repo#123 | PR URL> [--post] [--out review.md]

  --post        Publish the review to GitHub as a COMMENT (needs GITHUB_TOKEN with
                Pull requests: read and write). Without it, the review is only printed.
  --out <file>  Also save the review as Markdown.`;

const args = process.argv.slice(2);
const post = args.includes("--post");
const outIdx = args.indexOf("--out");
const outFile = outIdx >= 0 ? args[outIdx + 1] : undefined;
const target = args.find((a, i) => !a.startsWith("--") && !(outIdx >= 0 && i === outIdx + 1));

if (!target || (outIdx >= 0 && !outFile)) {
  console.error(USAGE);
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

let ref;
try {
  ref = parsePrRef(target);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

let maxBudgetUsd: number;
try {
  maxBudgetUsd = parseBudget(process.env.REVIEW_MAX_BUDGET_USD);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const githubToken = process.env.GITHUB_TOKEN || undefined;
if (post && !githubToken) {
  console.error("--post needs GITHUB_TOKEN in .env (fine-grained token with Pull requests: read and write).");
  process.exit(1);
}

// Use the configured MCP server, or start a private one in-process on a random port
// with a one-time token, so a review works from a single terminal.
let mcpUrl = process.env.MCP_SERVER_URL;
let mcpToken = process.env.MCP_AUTH_TOKEN || undefined;
let embedded: Awaited<ReturnType<typeof startHttpServer>> | undefined;
if (!mcpUrl) {
  mcpToken = randomBytes(24).toString("hex");
  embedded = await startHttpServer({
    root: repoRoot(),
    port: 0,
    token: mcpToken,
    github: new GitHubClient({ token: githubToken }),
    allowPost: post,
  });
  mcpUrl = embedded.url;
}

// Before paying for a review with --post: confirm the server can post, and record the PR's
// head commit so posting can refuse if new commits land while the review runs.
let reviewedHeadSha: string | undefined;
if (post) {
  let canPost = false;
  try {
    const probe = await mcpToolProvider(mcpUrl, mcpToken);
    try {
      canPost = (await probe.listTools()).some((t) => t.name === "post_review");
      const pr = await probe.callTool("get_pr", { pr: formatPrRef(ref) });
      if (pr.isError) throw new Error(pr.content.replace(/^Error:\s*/, ""));
      reviewedHeadSha = /^Head: ([0-9a-f]{40})/m.exec(pr.content)?.[1];
    } finally {
      await probe.close();
    }
  } catch (e) {
    console.error(`Could not prepare to post: ${(e as Error).message}`);
    embedded?.server.close();
    process.exit(1);
  }
  if (!canPost) {
    console.error(
      `The MCP server at ${mcpUrl} has posting turned off, so --post would fail after the review.\n` +
        "Either remove MCP_SERVER_URL from .env (review then starts its own server that can post),\n" +
        "or restart `npm run serve` with GITHUB_TOKEN and GITHUB_ALLOW_POST=true in .env.",
    );
    process.exit(1);
  }
}

console.error(`Reviewing ${formatPrRef(ref)} (tools: ${embedded ? "embedded MCP server" : mcpUrl})\n`);

try {
  const result = await runReview(ref, {
    mcpUrl,
    mcpToken,
    maxBudgetUsd,
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
        head_sha: reviewedHeadSha,
      });
      if (r.isError) {
        const hint = /not found/i.test(r.content) && !embedded
          ? " (start the MCP server with GITHUB_TOKEN and GITHUB_ALLOW_POST=true)"
          : "";
        throw new Error(`${r.content}${hint}`);
      }
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
  embedded?.server.closeAllConnections();
  embedded?.server.close();
}
