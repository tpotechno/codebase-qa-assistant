import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReviewArgs, preparePost, UsageError } from "../src/review-cli-lib.ts";
import { startHttpServer } from "../src/mcp-server.ts";
import { GitHubClient } from "../src/github.ts";
import { mcpToolProvider, type ToolProvider } from "../src/tool-provider.ts";
import { HEAD_SHA, fakeGitHub } from "./fixtures/fake-github.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ref = { owner: "acme", repo: "widgets", number: 7 };

test("parseReviewArgs handles flags in any order", () => {
  assert.deepEqual(parseReviewArgs(["acme/widgets#7"]), { ref, post: false, outFile: undefined });
  assert.deepEqual(parseReviewArgs(["--post", "acme/widgets#7", "--out", "r.md"]), { ref, post: true, outFile: "r.md" });
});

test("parseReviewArgs rejects bad usage", () => {
  const cases: Array<[string[], RegExp]> = [
    [[], /Missing the pull request/],
    [["acme/widgets#7", "acme/widgets#8"], /exactly one/],
    [["acme/widgets#7", "--out"], /--out needs a file name/],
    [["acme/widgets#7", "--out", "--post"], /--out needs a file name/],
    [["acme/widgets#7", "--dry-run"], /Unknown option: --dry-run/],
  ];
  for (const [argv, re] of cases) {
    assert.throws(() => parseReviewArgs(argv), (e: Error) => e instanceof UsageError && re.test(e.message), argv.join(" "));
  }
  assert.throws(() => parseReviewArgs(["../..#1"]), /owner and repo can't be/);
});

let canPost: Awaited<ReturnType<typeof startHttpServer>>;
let readOnly: Awaited<ReturnType<typeof startHttpServer>>;
before(async () => {
  const gh = fakeGitHub();
  canPost = await startHttpServer({ root, port: 0, allowPost: true, github: new GitHubClient({ token: "t", fetch: gh.fetch }) });
  readOnly = await startHttpServer({ root, port: 0, github: new GitHubClient({ fetch: gh.fetch }) });
});
after(() => {
  canPost.server.close();
  readOnly.server.close();
});

async function withTools<T>(url: string, fn: (t: ToolProvider) => Promise<T>): Promise<T> {
  const t = await mcpToolProvider(url);
  try {
    return await fn(t);
  } finally {
    await t.close();
  }
}

test("preparePost returns the real head SHA when posting is possible", async () => {
  const r = await withTools(canPost.url, (t) => preparePost(t, ref, canPost.url));
  assert.equal(r.headSha, HEAD_SHA);
});

test("preparePost fails closed: posting off, PR unreadable, or SHA unknown", async () => {
  await assert.rejects(withTools(readOnly.url, (t) => preparePost(t, ref, readOnly.url)), /posting turned off/);
  await assert.rejects(withTools(canPost.url, (t) => preparePost(t, { ...ref, number: 99 }, canPost.url)), /GitHub 404/);

  const oddServer: ToolProvider = {
    source: "fake",
    listTools: async () => [{ name: "post_review", description: "", input_schema: { type: "object" } }],
    callTool: async () => ({ content: "acme/widgets#7: Title\nHead: (unknown)", isError: false }),
    close: async () => {},
  };
  await assert.rejects(preparePost(oddServer, ref, "fake"), /Could not determine the PR's head commit/);
});
