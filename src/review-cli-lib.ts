import { extractHeadSha, formatPrRef, parsePrRef, type PrRef } from "./github.ts";
import type { ToolProvider } from "./tool-provider.ts";

/** Testable pieces of the review command. review-cli.ts wires them to the real world. */

export const USAGE = `Usage: npm run review -- <owner/repo#123 | PR URL> [--post] [--out review.md]

  --post        Publish the review to GitHub as a COMMENT (needs GITHUB_TOKEN with
                Pull requests: read and write). Without it, the review is only printed.
  --out <file>  Also save the review as Markdown.`;

export interface ReviewArgs {
  ref: PrRef;
  post: boolean;
  outFile?: string;
}

export class UsageError extends Error {}

export function parseReviewArgs(argv: string[]): ReviewArgs {
  let post = false;
  let outFile: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--post") post = true;
    else if (a === "--out") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new UsageError("--out needs a file name.");
      outFile = value;
    } else if (a.startsWith("--")) throw new UsageError(`Unknown option: ${a}`);
    else positional.push(a);
  }

  if (positional.length !== 1) {
    throw new UsageError(positional.length ? "Give exactly one pull request." : "Missing the pull request to review.");
  }
  return { ref: parsePrRef(positional[0]), post, outFile };
}

export interface PostPreflight {
  /** Head commit at the start of the review; posting refuses if the PR has moved on. */
  headSha: string;
}

/**
 * Run before paying for a review with --post. Fails closed: if the server can't post,
 * the PR can't be read, or its head commit can't be determined, nothing proceeds.
 */
export async function preparePost(tools: ToolProvider, ref: PrRef, serverLabel: string): Promise<PostPreflight> {
  const names = (await tools.listTools()).map((t) => t.name);
  if (!names.includes("post_review")) {
    throw new Error(
      `The MCP server at ${serverLabel} has posting turned off, so --post would fail after the review.\n` +
        "Either remove MCP_SERVER_URL from .env (review then starts its own server that can post),\n" +
        "or restart `npm run serve` with GITHUB_TOKEN and GITHUB_ALLOW_POST=true in .env.",
    );
  }
  const pr = await tools.callTool("get_pr", { pr: formatPrRef(ref) });
  if (pr.isError) throw new Error(pr.content.replace(/^Error:\s*/, ""));
  const headSha = extractHeadSha(pr.content);
  if (!headSha) {
    throw new Error("Could not determine the PR's head commit, so posting can't be protected against new commits.");
  }
  return { headSha };
}
