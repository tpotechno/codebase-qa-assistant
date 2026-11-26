import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitHubClient } from "../src/github.ts";
import {
  RepoError,
  RepoRegistry,
  parseLocation,
  repoPolicyFromEnv,
  type GitRunner,
  type RepoPolicy,
} from "../src/repos.ts";
import { DEV_SHA, HEAD_SHA, fakeGitHub } from "./fixtures/fake-github.ts";

// ---------- parseLocation ----------

test("parseLocation reads GitHub shorthand, branches and URLs", () => {
  assert.deepEqual(parseLocation("acme/widgets"), { kind: "github", owner: "acme", repo: "widgets", ref: undefined });
  assert.deepEqual(parseLocation("acme/widgets@feature/x"), { kind: "github", owner: "acme", repo: "widgets", ref: "feature/x" });
  assert.deepEqual(parseLocation("https://github.com/acme/widgets.git"), { kind: "github", owner: "acme", repo: "widgets", ref: undefined });
  assert.deepEqual(parseLocation("github.com/acme/widgets/tree/dev/"), { kind: "github", owner: "acme", repo: "widgets", ref: "dev" });
});

test("parseLocation treats absolute paths as folders, quoted or not", () => {
  const win = path.win32.isAbsolute;
  assert.deepEqual(parseLocation("C:\\source\\repos\\app", win), { kind: "local", path: "C:\\source\\repos\\app" });
  assert.deepEqual(parseLocation('"C:\\My Repos\\app"', win), { kind: "local", path: "C:\\My Repos\\app" });
  assert.deepEqual(parseLocation("/srv/app", path.posix.isAbsolute), { kind: "local", path: "/srv/app" });
});

test("parseLocation refuses relative paths, odd names and option-like branches", () => {
  for (const bad of ["", "app", "src/app/x", "acme/widgets@-upload-pack=evil", "acme/..", "acme/widgets@a..b", "-x/widgets"]) {
    assert.throws(() => parseLocation(bad, path.posix.isAbsolute), (e) => e instanceof RepoError && e.status === 400, bad);
  }
});

// ---------- policy ----------

test("repoPolicyFromEnv: local folders only where they make sense", () => {
  assert.equal(repoPolicyFromEnv("local", {}).allowLocal, true);
  assert.equal(repoPolicyFromEnv("hosted", {}).allowLocal, false);
  assert.equal(repoPolicyFromEnv("hosted", { REPO_ALLOWED_ROOTS: "/srv/repos" }).allowLocal, true);
  const demo = repoPolicyFromEnv("demo", { REPO_ALLOWED_ROOTS: "/srv/repos" });
  assert.equal(demo.allowLocal, false);
  assert.equal(demo.allowPrivate, false);
  assert.equal(demo.maxRepoMb, 50);
  assert.equal(repoPolicyFromEnv("local", { REPO_ALLOW_GITHUB: "false" }).allowGitHub, false);
  assert.equal(repoPolicyFromEnv("local", { REPO_MAX_MB: "75" }).maxRepoMb, 75);
  assert.throws(() => repoPolicyFromEnv("local", { REPO_MAX_MB: "lots" }), /REPO_MAX_MB/);
});

// ---------- helpers ----------

async function tempDir(t: { after: (fn: () => Promise<void>) => void }, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function policy(cacheDir: string, over: Partial<RepoPolicy> = {}): RepoPolicy {
  return {
    allowLocal: true,
    allowedRoots: [],
    allowGitHub: true,
    allowPrivate: true,
    maxRepoMb: 10,
    cacheMaxMb: 100,
    maxConcurrentClones: 2,
    cloneTimeoutMs: 5_000,
    cacheDir,
    ...over,
  };
}

/**
 * A stand-in for git: "clone" writes a small checkout (plus a .git folder) into the target,
 * "rev-parse" answers with the commit of the branch that was cloned. Records every call.
 */
function fakeGit(opts: { fileBytes?: number; delayMs?: number } = {}) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const shaOf = new Map<string, string>();
  const run: GitRunner = async (args, o) => {
    calls.push({ args, env: o.env });
    if (args.includes("clone")) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const target = args[args.length - 1];
      const branch = args[args.indexOf("--branch") + 1];
      await fs.mkdir(path.join(target, ".git"), { recursive: true });
      await fs.writeFile(path.join(target, "README.md"), "# Widgets\n\nMakes widgets.\n");
      await fs.writeFile(path.join(target, "big.bin"), Buffer.alloc(opts.fileBytes ?? 10));
      shaOf.set(target, branch === "dev" ? DEV_SHA : HEAD_SHA);
      return "";
    }
    if (args.includes("rev-parse")) return `${shaOf.get(o.cwd!)}\n`;
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  return { run, calls, clones: () => calls.filter((c) => c.args.includes("clone")).length };
}

const gh = (o: Parameters<typeof fakeGitHub>[0] = {}, token?: string) =>
  new GitHubClient({ token, fetch: fakeGitHub(o).fetch });

// ---------- local folders ----------

test("resolve opens a local folder and confines rootFor to it", async (t) => {
  const base = await tempDir(t, "cqa-local-");
  const repos = new RepoRegistry({ defaultRoot: base, policy: policy(base), github: gh() });
  const info = await repos.resolve(base);
  assert.equal(info.kind, "local");
  assert.ok(info.id);
  assert.equal(repos.rootFor(info.id!), await fs.realpath(base));
  // Loading the same folder again reuses its id.
  assert.equal((await repos.resolve(base)).id, info.id);
  assert.equal(repos.rootFor("00000000-0000-4000-8000-000000000000"), undefined);
});

test("resolve refuses missing folders, files, folders outside the allowlist, and folders when off", async (t) => {
  const base = await tempDir(t, "cqa-local-");
  const allowed = path.join(base, "allowed");
  await fs.mkdir(allowed);
  await fs.writeFile(path.join(base, "file.txt"), "x");
  const repos = new RepoRegistry({ defaultRoot: base, policy: policy(base, { allowedRoots: [allowed] }), github: gh() });

  const status = (p: Promise<unknown>) => p.then(() => 0, (e: RepoError) => e.status);
  assert.equal(await status(repos.resolve(path.join(base, "nope"))), 404);
  assert.equal(await status(repos.resolve(path.join(base, "file.txt"))), 400);
  assert.equal(await status(repos.resolve(base)), 403); // the parent of the allowed folder
  assert.equal(await status(repos.resolve(path.join(allowed, ".."))), 403);
  assert.ok((await repos.resolve(allowed)).id);

  const off = new RepoRegistry({ defaultRoot: base, policy: policy(base, { allowLocal: false }), github: gh() });
  assert.equal(await status(off.resolve(allowed)), 403);
});

test("ids expire after their TTL", async (t) => {
  const base = await tempDir(t, "cqa-local-");
  let now = 1_000;
  const repos = new RepoRegistry({ defaultRoot: base, policy: policy(base), github: gh(), idTtlMs: 100, now: () => now });
  const { id } = await repos.resolve(base);
  now += 50;
  assert.ok(repos.rootFor(id!)); // use refreshes it
  now += 120;
  assert.equal(repos.rootFor(id!), undefined);
});

// ---------- GitHub ----------

test("resolve clones a GitHub repo defensively, without .git, and reuses the clone", async (t) => {
  const cache = await tempDir(t, "cqa-cache-");
  const git = fakeGit();
  const repos = new RepoRegistry({ defaultRoot: cache, policy: policy(cache), github: gh(), git: git.run });

  const info = await repos.resolve("acme/widgets");
  assert.equal(info.kind, "github");
  assert.equal(info.name, "acme/widgets");
  assert.equal(info.label, "acme/widgets@main");
  assert.equal(info.sha, HEAD_SHA);
  const root = repos.rootFor(info.id!)!;
  assert.equal(path.dirname(root), cache);
  assert.match(await fs.readFile(path.join(root, "README.md"), "utf8"), /Widgets/);
  await assert.rejects(fs.stat(path.join(root, ".git")));

  // The clone is shallow, symlink-free, hook-free and https-only, with options ended by "--".
  const { args } = git.calls[0];
  for (const want of ["core.symlinks=false", "protocol.allow=never", "protocol.https.allow=always", "--depth", "--no-tags", "--template="]) {
    assert.ok(args.includes(want), want);
  }
  assert.deepEqual(args.slice(args.indexOf("--branch"), args.indexOf("--branch") + 2), ["--branch", "main"]);
  assert.equal(args[args.indexOf("--") + 1], "https://github.com/acme/widgets.git");

  await repos.resolve("https://github.com/acme/widgets");
  assert.equal(git.clones(), 1);
});

test("the token goes to git as a header in the environment, never in arguments; secrets are dropped", async (t) => {
  const cache = await tempDir(t, "cqa-cache-");
  const git = fakeGit();
  process.env.ANTHROPIC_API_KEY ??= "sk-test-not-real";
  const repos = new RepoRegistry({ defaultRoot: cache, policy: policy(cache), github: gh({}, "ghp_secret"), cloneToken: "ghp_secret", git: git.run });
  await repos.resolve("acme/widgets");

  const { args, env } = git.calls[0];
  assert.ok(!args.join(" ").includes("ghp_secret"));
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from("x-access-token:ghp_secret").toString("base64")}`);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
});

test("private, oversized and unknown repos are refused before any download", async (t) => {
  const cache = await tempDir(t, "cqa-cache-");
  const status = (p: Promise<unknown>) => p.then(() => 0, (e: RepoError) => e.status);
  const git = fakeGit();
  const make = (o: Parameters<typeof fakeGitHub>[0], over: Partial<RepoPolicy> = {}) =>
    new RepoRegistry({ defaultRoot: cache, policy: policy(cache, over), github: gh(o), git: git.run });

  assert.equal(await status(make({ privateRepo: true }, { allowPrivate: false }).resolve("acme/widgets")), 403);
  assert.equal(await status(make({ repoSizeKb: 50 * 1024 }).resolve("acme/widgets")), 413);
  assert.equal(await status(make({}).resolve("acme/nothing")), 404);
  assert.equal(await status(make({}).resolve("acme/widgets@no-such-branch")), 404);
  assert.equal(await status(make({}, { allowGitHub: false }).resolve("acme/widgets")), 403);
  assert.equal(git.clones(), 0);
});

test("a checkout over the size cap is deleted and refused", async (t) => {
  const cache = await tempDir(t, "cqa-cache-");
  const git = fakeGit({ fileBytes: 2 * 1024 * 1024 });
  const repos = new RepoRegistry({ defaultRoot: cache, policy: policy(cache, { maxRepoMb: 1 }), github: gh(), git: git.run });
  await assert.rejects(repos.resolve("acme/widgets"), (e: RepoError) => e.status === 413);
  const left = (await fs.readdir(cache)).filter((n) => !n.startsWith(".no-hooks") && n !== ".empty-gitconfig");
  assert.deepEqual(left, []);
});

test("concurrent loads of one repo share a download; another repo is refused while it runs", async (t) => {
  const cache = await tempDir(t, "cqa-cache-");
  const git = fakeGit({ delayMs: 30 });
  const repos = new RepoRegistry({ defaultRoot: cache, policy: policy(cache, { maxConcurrentClones: 1 }), github: gh(), git: git.run });
  const [a, b, c] = await Promise.allSettled([
    repos.resolve("acme/widgets"),
    repos.resolve("acme/widgets"),
    repos.resolve("acme/widgets@dev"),
  ]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "fulfilled");
  assert.equal(c.status === "rejected" && (c.reason as RepoError).status, 429);
  assert.equal(git.clones(), 1);
});

test("the least recently used clone is evicted past the cache cap, and its id stops working", async (t) => {
  const cache = await tempDir(t, "cqa-cache-");
  const git = fakeGit({ fileBytes: 700 * 1024 });
  let now = 1_000;
  const repos = new RepoRegistry({ defaultRoot: cache, policy: policy(cache, { cacheMaxMb: 1 }), github: gh(), git: git.run, now: () => now });
  const main = await repos.resolve("acme/widgets");
  now += 10;
  const dev = await repos.resolve("acme/widgets@dev");
  assert.equal(dev.sha, DEV_SHA);
  assert.equal(repos.rootFor(main.id!), undefined);
  assert.ok(repos.rootFor(dev.id!));
});

test("clones from an earlier run are adopted and reused", async (t) => {
  const cache = await tempDir(t, "cqa-cache-");
  const git = fakeGit();
  await new RepoRegistry({ defaultRoot: cache, policy: policy(cache), github: gh(), git: git.run }).resolve("acme/widgets");
  // A new registry (a restart, or the CLI next to the web app) finds the clone on disk.
  const again = new RepoRegistry({ defaultRoot: cache, policy: policy(cache), github: gh(), git: git.run });
  assert.ok((await again.resolve("acme/widgets")).id);
  assert.equal(git.clones(), 1);
});
