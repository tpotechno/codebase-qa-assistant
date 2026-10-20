import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, extractHeadSha, formatPrDiff, isGeneratedFile, formatPrSummary, neutralizeMentions, parsePatch, parsePrRef } from "../src/github.ts";
import { HEAD_SHA, PATCH, fakeGitHub } from "./fixtures/fake-github.ts";

const ref = { owner: "acme", repo: "widgets", number: 7 };

test("parsePrRef accepts short refs and PR URLs, rejects junk", () => {
  assert.deepEqual(parsePrRef("acme/widgets#7"), ref);
  assert.deepEqual(parsePrRef("acme/widgets/7"), ref);
  assert.deepEqual(parsePrRef("https://github.com/acme/widgets/pull/7/files"), ref);
  assert.throws(() => parsePrRef("widgets#7"), /Not a pull request reference/);
});

test("parsePatch numbers new-file lines and marks only them commentable", () => {
  const { commentableLines, annotated } = parsePatch(PATCH);
  // Lines 1-5 exist in the new file (1 context, 2 added, 2 context); the removed line has none.
  assert.deepEqual([...commentableLines].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.match(annotated, /^\s+2 \+ const port = Number/m);
  assert.match(annotated, /^\s+- const port = 3000;/m);
  assert.equal(parsePatch(undefined).commentableLines.size, 0);
});

test("getPr returns metadata and files, sends the token when set", async () => {
  const gh = fakeGitHub();
  const pr = await new GitHubClient({ token: "t0k", fetch: gh.fetch }).getPr(ref);
  assert.equal(pr.title, "Read port from environment");
  assert.equal(pr.headSha, HEAD_SHA);
  assert.equal(pr.files[0].filename, "src/server.ts");
  assert.ok(gh.requests.every((r) => r.auth === "Bearer t0k"));
  assert.match(formatPrSummary(pr), /acme\/widgets#7: Read port from environment/);
});

test("getPr pages through more than 100 changed files", async () => {
  const gh = fakeGitHub({ fileCount: 150 });
  const pr = await new GitHubClient({ fetch: gh.fetch }).getPr(ref);
  assert.equal(pr.files.length, 150);
  assert.equal(gh.requests.filter((r) => r.path.includes("/files")).length, 2);
});

test("errors carry the status and a hint", async () => {
  const gh = fakeGitHub();
  await assert.rejects(
    new GitHubClient({ fetch: gh.fetch }).getPr({ ...ref, number: 99 }),
    /GitHub 404 .*private repos need GITHUB_TOKEN/,
  );
});

test("formatPrDiff filters by path and pages large diffs", async () => {
  const pr = await new GitHubClient({ fetch: fakeGitHub({ fileCount: 2000 }).fetch }).getPr(ref);
  const one = formatPrDiff(pr, { path: "src/server.ts" });
  assert.match(one, /=== src\/server\.ts \(modified/);
  assert.match(formatPrDiff(pr, { path: "nope.ts" }), /^Error: "nope.ts" is not one of the files changed/);
  const first = formatPrDiff(pr);
  assert.match(first, /Page 1 of \d+ — call again with page=2/);
  assert.ok(first.length < 26_000);
});

test("postReview posts a COMMENT and folds out-of-diff comments into the body", async () => {
  const gh = fakeGitHub();
  const r = await new GitHubClient({ token: "t0k", fetch: gh.fetch }).postReview(ref, "Overall fine.", [
    { path: "src/server.ts", line: 2, body: "PORT may be unset; Number(undefined) is NaN." },
    { path: "src/server.ts", line: 40, body: "Outside the diff." },
    { path: "other.ts", line: 1, body: "Not a changed file." },
  ]);
  assert.deepEqual(r, { url: "https://github.com/acme/widgets/pull/7#pullrequestreview-1", inlineCount: 1, foldedCount: 2 });

  const sent = gh.requests.find((x) => x.method === "POST")!.body;
  assert.equal(sent.event, "COMMENT");
  assert.equal(sent.commit_id, HEAD_SHA);
  assert.deepEqual(sent.comments, [
    { path: "src/server.ts", line: 2, body: "PORT may be unset; Number(undefined) is NaN.", side: "RIGHT" },
  ]);
  assert.match(sent.body, /Additional notes[\s\S]*src\/server\.ts:40[\s\S]*other\.ts:1/);
});

test("generated files are collapsed unless requested by path", async () => {
  assert.ok(isGeneratedFile("package-lock.json"));
  assert.ok(isGeneratedFile("web/yarn.lock"));
  assert.ok(isGeneratedFile("dist/app.min.js"));
  assert.ok(!isGeneratedFile("src/package-lock-parser.ts"));

  const pr = await new GitHubClient({ fetch: fakeGitHub().fetch }).getPr(ref);
  pr.files.push({ filename: "package-lock.json", status: "modified", additions: 900, deletions: 40, changes: 940, patch: "@@ -1 +1 @@\n-a\n+b" });
  assert.match(formatPrDiff(pr), /package-lock\.json[^\n]*\n\(generated file; diff omitted/);
  assert.match(formatPrDiff(pr, { path: "package-lock.json" }), /1 \+ b/);
});

test("parsePatch ignores a trailing newline and CRLF artifacts (no phantom lines)", () => {
  const withTrailing = parsePatch(`${PATCH}\n`);
  assert.deepEqual([...withTrailing.commentableLines].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  const crlf = parsePatch(PATCH.split("\n").join("\r\n"));
  assert.deepEqual([...crlf.commentableLines].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.doesNotMatch(crlf.annotated, /\r/);
});

test("a file larger than one page is split into parts, with every line reachable", async () => {
  const pr = await new GitHubClient({ fetch: fakeGitHub().fetch }).getPr(ref);
  const n = 3_000;
  const patch = [`@@ -0,0 +1,${n} @@`, ...Array.from({ length: n }, (_, i) => `+const line${i + 1} = "${"x".repeat(20)}";`)].join("\n");
  pr.files = [{ filename: "src/big.ts", status: "added", additions: n, deletions: 0, changes: n, patch }];

  for (const opts of [{}, { path: "src/big.ts" }]) {
    const first = formatPrDiff(pr, opts);
    const total = Number(/Page 1 of (\d+)/.exec(first)![1]);
    assert.ok(total > 1);
    const all = Array.from({ length: total }, (_, i) => formatPrDiff(pr, { ...opts, page: i + 1 })).join("\n");
    assert.doesNotMatch(all, /truncated/);
    assert.match(all, /\[part 1 of \d+\]/);
    assert.match(all, new RegExp(`^\\s+${n} \\+ const line${n} =`, "m"));
    for (let p = 1; p <= total; p++) assert.ok(formatPrDiff(pr, { ...opts, page: p }).length < 26_000);
  }
});

test("getPr is cached briefly, shared across callers, and bypassed with fresh", async () => {
  const gh = fakeGitHub();
  const client = new GitHubClient({ fetch: gh.fetch });
  await Promise.all([client.getPr(ref), client.getPr(ref), client.getPr(ref)]);
  await client.getPr(ref);
  assert.equal(gh.requests.length, 2, "one PR fetch + one files fetch for four calls");
  await client.getPr(ref, { fresh: true });
  assert.equal(gh.requests.length, 4);

  const noCache = new GitHubClient({ fetch: gh.fetch, cacheTtlMs: 0 });
  await noCache.getPr(ref);
  await noCache.getPr(ref);
  assert.equal(gh.requests.length, 8);
});

test("failed fetches are not cached", async () => {
  const gh = fakeGitHub();
  const client = new GitHubClient({ fetch: gh.fetch });
  const missing = { ...ref, number: 99 };
  await assert.rejects(client.getPr(missing));
  await assert.rejects(client.getPr(missing));
  assert.equal(gh.requests.length, 2);
});

test("postReview refuses when the PR moved past the reviewed commit", async () => {
  const gh = fakeGitHub();
  const client = new GitHubClient({ token: "t0k", fetch: gh.fetch });
  await assert.rejects(
    client.postReview(ref, "body", [], { expectedHeadSha: "f".repeat(40) }),
    /new commits since it was reviewed \(reviewed fffffff, now a1b2c3d\)/,
  );
  assert.ok(!gh.requests.some((r) => r.method === "POST"), "nothing posted");
  const ok = await client.postReview(ref, "body", [], { expectedHeadSha: HEAD_SHA });
  assert.match(ok.url, /pullrequestreview/);
});

test("parsePrRef rejects dot segments that could redirect an authenticated request", () => {
  for (const bad of ["../..#1", "./widgets#1", "acme/..#1", "../../1", "https://github.com/../x/pull/1"]) {
    assert.throws(() => parsePrRef(bad), /Not a pull request reference/, bad);
  }
  assert.deepEqual(parsePrRef("my.org/my.repo#3"), { owner: "my.org", repo: "my.repo", number: 3 });
});

test("extractHeadSha reads the SHA from real get_pr output and fails on anything else", async () => {
  const pr = await new GitHubClient({ fetch: fakeGitHub().fetch }).getPr(ref);
  assert.equal(extractHeadSha(formatPrSummary(pr)), HEAD_SHA);
  assert.equal(extractHeadSha("Head: abc123 | +1 -0"), undefined);
  assert.equal(extractHeadSha("no head line"), undefined);
});

test("the PR cache evicts expired entries and stays bounded", async () => {
  const gh = fakeGitHub();
  const expiring = new GitHubClient({ fetch: gh.fetch, cacheTtlMs: 1 });
  await expiring.getPr(ref);
  await new Promise((r) => setTimeout(r, 5));
  await expiring.getPr({ ...ref, number: 99 }).catch(() => {});
  assert.equal((expiring as any).cache.size, 0, "expired success evicted, failure never cached");

  const bounded = new GitHubClient({ fetch: async () => new Response("{}", { status: 500 }), cacheTtlMs: 3_600_000 });
  (bounded as any).fetchPr = async () => ({}); // succeed instantly without HTTP
  for (let n = 1; n <= 120; n++) await bounded.getPr({ ...ref, number: n });
  assert.ok((bounded as any).cache.size <= 50);
});

test("neutralizeMentions wraps @mentions in code spans but leaves emails and code alone", () => {
  assert.equal(neutralizeMentions("cc @octocat please"), "cc `@octocat` please");
  assert.equal(neutralizeMentions("@acme/security look"), "`@acme/security` look");
  assert.equal(neutralizeMentions("mail dev@example.com"), "mail dev@example.com");
  assert.equal(neutralizeMentions("use `@Input()` here"), "use `@Input()` here");
});

test("postReview neutralizes mentions in the body and inline comments", async () => {
  const gh = fakeGitHub();
  await new GitHubClient({ token: "t", fetch: gh.fetch }).postReview(ref, "Summary for @boss", [
    { path: "src/server.ts", line: 2, body: "ping @team" },
  ]);
  const sent = gh.requests.find((x) => x.method === "POST")!.body;
  assert.equal(sent.body, "Summary for `@boss`");
  assert.equal(sent.comments[0].body, "ping `@team`");
});
