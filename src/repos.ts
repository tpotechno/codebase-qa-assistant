import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { GitHubClient } from "./github.ts";
import { isInside } from "./tools.ts";

/**
 * Lets a person choose which codebase Ask works on: a local folder, or a GitHub repository
 * that is shallow-cloned into a cache.
 *
 * The choice is the person's, never the model's. A location is resolved here into a
 * server-issued id; the MCP server then serves that root at /mcp/<id> (see mcp-server.ts).
 * The tools themselves are unchanged and still cannot name a root.
 *
 * GitHub repos are untrusted input, so they are cloned defensively (see SAFE_GIT_CONFIG and
 * gitEnv) and checked for size before and after download.
 */

/** Where the server runs, which decides the defaults below. */
export type RepoMode = "local" | "hosted" | "demo";

export interface RepoPolicy {
  /** Allow local folders at all. */
  allowLocal: boolean;
  /** If non-empty, local folders must be inside one of these. Empty means any folder. */
  allowedRoots: string[];
  /** Allow GitHub repos (cloned on demand). */
  allowGitHub: boolean;
  /** Allow private GitHub repos (needs a token that can read them). */
  allowPrivate: boolean;
  /** Largest repo to open, in MB (GitHub's reported size, and the checkout on disk). */
  maxRepoMb: number;
  /** Total disk the clone cache may use, in MB; least recently used clones go first. */
  cacheMaxMb: number;
  maxConcurrentClones: number;
  cloneTimeoutMs: number;
  cacheDir: string;
}

const MB = 1024 * 1024;

/** Defaults per mode; see docs/repo_selection_design.md for the reasoning. */
const DEFAULTS: Record<RepoMode, { maxRepoMb: number; cacheMaxMb: number; clones: number; timeoutMs: number }> = {
  local: { maxRepoMb: 500, cacheMaxMb: 2_000, clones: 2, timeoutMs: 120_000 },
  hosted: { maxRepoMb: 200, cacheMaxMb: 1_000, clones: 1, timeoutMs: 120_000 },
  demo: { maxRepoMb: 50, cacheMaxMb: 500, clones: 1, timeoutMs: 60_000 },
};

/** A whole number above zero from the environment; unset or blank means the fallback. */
export function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number above 0 (got "${raw}").`);
  return n;
}

/**
 * Build the policy from the environment. Throws with a clear message on a bad number.
 *   REPO_ALLOWED_ROOTS  comma-separated folders local paths must be inside (local: optional;
 *                       hosted: local folders are off unless this is set; demo: always off)
 *   REPO_ALLOW_GITHUB   "false" turns GitHub cloning off
 *   REPO_MAX_MB, REPO_CACHE_MAX_MB, REPO_CACHE_DIR
 */
export function repoPolicyFromEnv(mode: RepoMode, env: NodeJS.ProcessEnv = process.env): RepoPolicy {
  const d = DEFAULTS[mode];
  const allowedRoots =
    mode === "demo"
      ? []
      : (env.REPO_ALLOWED_ROOTS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((p) => path.resolve(p));
  return {
    // Locally the person owns the machine; hosted, only explicitly allowed folders; the
    // public demo never opens container folders.
    allowLocal: mode === "local" || (mode === "hosted" && allowedRoots.length > 0),
    allowedRoots,
    allowGitHub: env.REPO_ALLOW_GITHUB?.trim().toLowerCase() !== "false",
    // The public demo has no token and must not be able to reach private code anyway.
    allowPrivate: mode !== "demo",
    maxRepoMb: parsePositiveInt(env.REPO_MAX_MB, d.maxRepoMb, "REPO_MAX_MB"),
    cacheMaxMb: parsePositiveInt(env.REPO_CACHE_MAX_MB, d.cacheMaxMb, "REPO_CACHE_MAX_MB"),
    maxConcurrentClones: d.clones,
    cloneTimeoutMs: d.timeoutMs,
    cacheDir: path.resolve(env.REPO_CACHE_DIR?.trim() || path.join(os.tmpdir(), "codebase-qa-repos")),
  };
}

/** A failure to show the person, with the HTTP status the web API should answer with. */
export class RepoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RepoError";
  }
}

export type Location =
  | { kind: "local"; path: string }
  | { kind: "github"; owner: string; repo: string; ref?: string };

// GitHub's own rules for user/org names, plus a conservative repo-name and branch pattern.
// The branch must not start with "-", so it can never be read by git as an option.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
const GITHUB_URL =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?(?:\/tree\/([^\s?#]+?))?\/?(?:[?#].*)?$/i;
const SHORTHAND = /^([^/\s@\\]+)\/([^/\s@\\]+?)(?:\.git)?(?:@(\S+))?$/;

const HOW_TO =
  "Enter a full folder path (e.g. C:\\source\\repos\\my-app) or a GitHub repository " +
  "(owner/repo, owner/repo@branch or a github.com URL).";

/**
 * Work out what the person typed. Absolute paths are folders; `owner/repo[@ref]` and
 * github.com URLs are GitHub. Relative paths are refused rather than guessed at, since
 * "relative to what" isn't obvious on a server.
 */
export function parseLocation(input: string, isAbsolute: (p: string) => boolean = path.isAbsolute): Location {
  // Windows "Copy as path" wraps the path in quotes; accept that.
  const s = input.trim().replace(/^"(.*)"$/, "$1").trim();
  if (!s) throw new RepoError(400, HOW_TO);

  const url = GITHUB_URL.exec(s);
  if (url) return github(url[1], url[2], url[3]);
  if (isAbsolute(s)) return { kind: "local", path: s };
  const short = SHORTHAND.exec(s);
  if (short) return github(short[1], short[2], short[3]);
  throw new RepoError(400, HOW_TO);
}

function github(owner: string, repo: string, ref?: string): Location {
  const badRef = ref !== undefined && (!REF.test(ref) || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock"));
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === ".." || badRef) {
    throw new RepoError(400, `That doesn't look like a GitHub repository. ${HOW_TO}`);
  }
  return { kind: "github", owner, repo, ref };
}

/** What the UI is told about a chosen codebase. The cache path of a clone is not exposed. */
export interface RepoInfo {
  /** Server-issued id to send with each question; null for the server's built-in repo. */
  id: string | null;
  name: string;
  /** Longer description: the folder path, or owner/repo@branch. */
  label: string;
  kind: "builtin" | "local" | "github";
  /** Commit that was cloned (GitHub only). */
  sha?: string;
  url?: string;
}

/** Runs git with an argument list (never through a shell) and returns stdout. */
export type GitRunner = (args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;

/**
 * A GitRunner backed by a real executable. `command` is "git" in normal use; tests point it
 * at another program to check the error and timeout handling without git or a network.
 */
export const execGit = (command = "git"): GitRunner => (args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 4 * MB },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        // Last line of git's stderr is the useful part ("fatal: Remote branch x not found").
        const last = String(stderr).trim().split(/\r?\n/).pop();
        const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
        reject(new Error(timedOut ? "the download took too long" : last || err.message));
      },
    );
  });

export const defaultGit: GitRunner = execGit();

/**
 * Settings for every git call on an untrusted repository:
 * - symlinks are checked out as plain files, so none can point outside the clone
 *   (read_file's real-path check would refuse them anyway; this is a second layer);
 * - hooks are pointed at a folder that doesn't exist, and fsmonitor is off, so nothing
 *   from git config runs a program;
 * - only https is allowed, so a crafted URL or submodule can't use another transport.
 */
const safeGitConfig = (noHooksDir: string) => [
  "-c", "core.symlinks=false",
  "-c", `core.hooksPath=${noHooksDir}`,
  "-c", "core.fsmonitor=false",
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "core.longpaths=true",
  "-c", "advice.detachedHead=false",
];

/** Environment variables git may inherit; everything else (API keys included) is dropped. */
const PASS_THROUGH = new Set([
  "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE",
  "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
]);

interface Entry {
  info: RepoInfo;
  root: string;
  lastUsed: number;
}

interface Clone {
  dir: string;
  bytes: number;
  lastUsed: number;
}

export interface RepoRegistryOptions {
  /** The server's built-in repository (REPO_PATH, or the demo's own source). */
  defaultRoot: string;
  policy: RepoPolicy;
  /** For repo metadata. Its token, if any, lets private repos resolve. */
  github: GitHubClient;
  /** Sent to git as an HTTP header for github.com, never in a URL or an argument. */
  cloneToken?: string;
  /** Injectable for tests, so they never run git or touch the network. */
  git?: GitRunner;
  /** How long an unused id stays valid. Default 6 hours. */
  idTtlMs?: number;
  now?: () => number;
}

const MAX_IDS = 200;

export class RepoRegistry {
  private readonly policy: RepoPolicy;
  private readonly git: GitRunner;
  private readonly now: () => number;
  private readonly idTtlMs: number;
  private readonly byId = new Map<string, Entry>();
  private readonly idByRoot = new Map<string, string>();
  private readonly clones = new Map<string, Clone>();
  private readonly inFlight = new Map<string, Promise<{ dir: string; sha: string }>>();
  private activeClones = 0;
  private cacheReady?: Promise<void>;

  constructor(private readonly opts: RepoRegistryOptions) {
    this.policy = opts.policy;
    this.git = opts.git ?? defaultGit;
    this.now = opts.now ?? Date.now;
    this.idTtlMs = opts.idTtlMs ?? 6 * 60 * 60_000;
  }

  /** What the UI may offer: folders, GitHub repos, or neither. */
  get choice(): { local: boolean; github: boolean } {
    return { local: this.policy.allowLocal, github: this.policy.allowGitHub };
  }

  defaultRepo(): RepoInfo {
    const root = this.opts.defaultRoot;
    return { id: null, name: path.basename(root) || root, label: root, kind: "builtin" };
  }

  /** The root and info for an id from resolve(), or undefined if it's unknown or expired. */
  lookup(id: string): { root: string; info: RepoInfo } | undefined {
    const entry = this.byId.get(id);
    if (!entry) return undefined;
    if (this.now() - entry.lastUsed >= this.idTtlMs) {
      this.forget(id);
      return undefined;
    }
    entry.lastUsed = this.now();
    const clone = this.clones.get(entry.root);
    if (clone) clone.lastUsed = entry.lastUsed; // keeps a clone in use from being evicted first
    return { root: entry.root, info: entry.info };
  }

  /** Just the root, for the MCP server's /mcp/<id> route. */
  rootFor(id: string): string | undefined {
    return this.lookup(id)?.root;
  }

  /** Turn what the person typed into a confined root and an id for it. Throws RepoError. */
  async resolve(input: string): Promise<RepoInfo> {
    const loc = parseLocation(input);
    const { root, info } = loc.kind === "local" ? await this.resolveLocal(loc.path) : await this.resolveGitHub(loc);
    return this.register(root, info);
  }

  private async resolveLocal(p: string): Promise<{ root: string; info: Omit<RepoInfo, "id"> }> {
    if (!this.policy.allowLocal) {
      throw new RepoError(403, "This server doesn't open local folders. Enter a GitHub repository instead, e.g. owner/repo.");
    }
    const abs = path.resolve(p);
    // Real path, so the allowlist check can't be sidestepped with a symlink or junction.
    const real = await fs.realpath(abs).catch(() => undefined);
    if (!real) throw new RepoError(404, `Folder not found: ${abs}`);
    if (!(await fs.stat(real)).isDirectory()) throw new RepoError(400, `Not a folder: ${abs}`);

    if (this.policy.allowedRoots.length) {
      const roots = await Promise.all(this.policy.allowedRoots.map((r) => fs.realpath(r).catch(() => r)));
      if (!roots.some((r) => isInside(r, real))) {
        throw new RepoError(403, `${abs} is outside the folders this server may open (REPO_ALLOWED_ROOTS).`);
      }
    }
    return { root: real, info: { name: path.basename(real) || real, label: real, kind: "local" } };
  }

  private async resolveGitHub(loc: { owner: string; repo: string; ref?: string }): Promise<{ root: string; info: Omit<RepoInfo, "id"> }> {
    if (!this.policy.allowGitHub) throw new RepoError(403, "This server doesn't open GitHub repositories.");
    const name = `${loc.owner}/${loc.repo}`;

    // 1. Metadata first, so private and oversized repos are refused before any download.
    const meta = await this.opts.github.getRepo(loc.owner, loc.repo).catch((e) => {
      throw githubError(e, name);
    });
    if (meta.private && !this.policy.allowPrivate) {
      throw new RepoError(403, "Only public repositories can be opened here.");
    }
    if (meta.sizeKb > this.policy.maxRepoMb * 1024) {
      throw new RepoError(
        413,
        `${meta.fullName} is about ${Math.ceil(meta.sizeKb / 1024)} MB; this server opens repositories up to ${this.policy.maxRepoMb} MB.`,
      );
    }

    // 2. The exact commit, so a repeat visit reuses the cached clone until the branch moves.
    const branch = loc.ref ?? meta.defaultBranch;
    const sha = await this.opts.github.getCommitSha(loc.owner, loc.repo, branch).catch((e) => {
      const status = /GitHub (404|422)/.test((e as Error).message) ? 404 : undefined;
      if (status) throw new RepoError(404, `Branch or tag "${branch}" not found in ${meta.fullName}.`);
      throw githubError(e, name);
    });

    // 3. Clone (or reuse). GitHub's canonical owner/repo casing names the folder.
    const [owner, repo] = meta.fullName.split("/");
    const clone = await this.checkout(owner ?? loc.owner, repo ?? loc.repo, branch, sha);
    return {
      root: clone.dir,
      info: { name: meta.fullName, label: `${meta.fullName}@${branch}`, kind: "github", sha: clone.sha, url: meta.url },
    };
  }

  /** Give a root an id, reusing the existing one so repeat loads don't pile up ids. */
  private register(root: string, info: Omit<RepoInfo, "id">): RepoInfo {
    const now = this.now();
    for (const [id, e] of this.byId) if (now - e.lastUsed >= this.idTtlMs) this.forget(id);
    let id = this.idByRoot.get(root);
    if (!id) {
      // Oldest first (Map keeps insertion order); a generous cap, it only bounds memory.
      while (this.byId.size >= MAX_IDS) this.forget(this.byId.keys().next().value!);
      id = randomUUID();
      this.idByRoot.set(root, id);
    }
    const full: RepoInfo = { ...info, id };
    this.byId.set(id, { info: full, root, lastUsed: now });
    return full;
  }

  private forget(id: string): void {
    const e = this.byId.get(id);
    this.byId.delete(id);
    if (e && this.idByRoot.get(e.root) === id) this.idByRoot.delete(e.root);
  }

  // ---------- GitHub clone cache ----------

  private get noHooksDir() {
    return path.join(this.policy.cacheDir, ".no-hooks");
  }
  private get emptyGitConfig() {
    return path.join(this.policy.cacheDir, ".empty-gitconfig");
  }

  /**
   * Prepare the cache folder once per process. Clones from an earlier run (or from another
   * process sharing the folder, e.g. the CLI next to the web app) are adopted, with their
   * size measured, so they count toward the disk cap and can be reused. Temporary folders
   * older than an hour are abandoned downloads and are removed; newer ones may belong to a
   * download still running elsewhere. Only names this code creates are touched, in case
   * REPO_CACHE_DIR points somewhere shared.
   */
  private ensureCache(): Promise<void> {
    this.cacheReady ??= (async () => {
      const dir = this.policy.cacheDir;
      await fs.mkdir(dir, { recursive: true });
      for (const name of await fs.readdir(dir)) {
        const full = path.join(dir, name);
        const stat = await fs.stat(full).catch(() => undefined);
        if (!stat?.isDirectory()) continue;
        if (/^\.tmp-/.test(name)) {
          if (this.now() - stat.mtimeMs > 60 * 60_000) await fs.rm(full, { recursive: true, force: true });
        } else if (/__[0-9a-f]{12}$/.test(name)) {
          this.clones.set(full, { dir: full, bytes: await dirSize(full), lastUsed: stat.mtimeMs });
        }
      }
      await fs.writeFile(this.emptyGitConfig, "");
    })();
    // A failed setup (e.g. an unwritable folder) is retried on the next request.
    this.cacheReady.catch(() => (this.cacheReady = undefined));
    return this.cacheReady;
  }

  private async checkout(owner: string, repo: string, branch: string, sha: string): Promise<{ dir: string; sha: string }> {
    await this.ensureCache();
    const dir = cloneDir(this.policy.cacheDir, owner, repo, sha);
    const hit = this.clones.get(dir);
    if (hit) {
      hit.lastUsed = this.now();
      return { dir, sha };
    }
    // Two people loading the same repo at once share one download.
    const pending = this.inFlight.get(dir);
    if (pending) return pending;
    if (this.activeClones >= this.policy.maxConcurrentClones) {
      throw new RepoError(429, "Another repository is downloading. Try again in a moment.");
    }

    this.activeClones++;
    const work = this.clone(owner, repo, branch).finally(() => {
      this.activeClones--;
      this.inFlight.delete(dir);
    });
    this.inFlight.set(dir, work);
    return work;
  }

  private async clone(owner: string, repo: string, branch: string): Promise<{ dir: string; sha: string }> {
    const cacheDir = this.policy.cacheDir;
    // Clone into a temporary name and rename at the end, so a half-finished clone is never used.
    const tmp = path.join(cacheDir, `.tmp-${randomUUID()}`);
    const env = this.gitEnv();
    const timeoutMs = this.policy.cloneTimeoutMs;
    try {
      // The URL is built here from validated names, so it is always https://github.com.
      // "--" ends the options, and the branch was validated not to start with "-".
      await this.git(
        [
          ...safeGitConfig(this.noHooksDir),
          "clone", "--depth", "1", "--single-branch", "--no-tags", "--template=",
          "--branch", branch,
          "--", `https://github.com/${owner}/${repo}.git`, tmp,
        ],
        { env, timeoutMs },
      );
      // The commit actually cloned (the branch may have moved since the API was asked).
      const sha = (await this.git([...safeGitConfig(this.noHooksDir), "rev-parse", "HEAD"], { cwd: tmp, env, timeoutMs })).trim();
      // History isn't needed (the tools skip .git anyway); dropping it saves most of the disk.
      await fs.rm(path.join(tmp, ".git"), { recursive: true, force: true });

      const bytes = await dirSize(tmp);
      if (bytes > this.policy.maxRepoMb * MB) {
        throw new RepoError(413, `${owner}/${repo} is ${Math.ceil(bytes / MB)} MB checked out; this server opens repositories up to ${this.policy.maxRepoMb} MB.`);
      }

      const dir = cloneDir(cacheDir, owner, repo, /^[0-9a-f]{40}$/.test(sha) ? sha : "0".repeat(40));
      await fs.rename(tmp, dir).catch(async (e) => {
        // Already there (e.g. the branch moved onto a commit we have): keep the existing one.
        await fs.rm(tmp, { recursive: true, force: true });
        if (!(await exists(dir))) throw e;
      });
      this.clones.set(dir, { dir, bytes, lastUsed: this.now() });
      await this.evict(dir);
      return { dir, sha };
    } catch (e) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      if (e instanceof RepoError) throw e;
      throw new RepoError(502, `Could not download ${owner}/${repo}: ${(e as Error).message}`);
    }
  }

  /** Remove least recently used clones until the cache fits, never the one just made. */
  private async evict(keep: string): Promise<void> {
    let total = [...this.clones.values()].reduce((n, c) => n + c.bytes, 0);
    const oldestFirst = [...this.clones.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const c of oldestFirst) {
      if (total <= this.policy.cacheMaxMb * MB) break;
      if (c.dir === keep || this.inFlight.has(c.dir)) continue;
      await fs.rm(c.dir, { recursive: true, force: true }).catch(() => {});
      this.clones.delete(c.dir);
      total -= c.bytes;
      // Ids for an evicted clone stop working; the UI then asks the person to load it again.
      const id = this.idByRoot.get(c.dir);
      if (id) this.forget(id);
    }
  }

  /**
   * A minimal environment for git: no API keys, no user or system git config (so no
   * credential helpers, prompts or hooks from the machine), and the token, if any, as an
   * HTTP header scoped to https://github.com/.
   */
  private gitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (PASS_THROUGH.has(k.toUpperCase())) env[k] = v;
    env.GIT_TERMINAL_PROMPT = "0";
    env.GCM_INTERACTIVE = "never";
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = this.emptyGitConfig;
    env.GIT_LFS_SKIP_SMUDGE = "1";
    if (this.opts.cloneToken && this.policy.allowPrivate) {
      const basic = Buffer.from(`x-access-token:${this.opts.cloneToken}`).toString("base64");
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    }
    return env;
  }
}

/** Cache folder for one commit, e.g. octocat__hello-world__7fd1a60b01f9. */
function cloneDir(cacheDir: string, owner: string, repo: string, sha: string): string {
  return path.join(cacheDir, `${owner}__${repo}__${sha.slice(0, 12)}`.toLowerCase());
}

/** Map a GitHub API failure to something the person can act on. */
function githubError(e: unknown, name: string): RepoError {
  const msg = (e as Error).message;
  if (/GitHub 404/.test(msg)) return new RepoError(404, `Repository not found: ${name}. Private repositories need a GITHUB_TOKEN that can read them.`);
  if (/GitHub (403|429)/.test(msg)) return new RepoError(429, "GitHub refused the request (probably its rate limit). Try again later.");
  return new RepoError(502, msg);
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}

/** Bytes used by regular files under dir (symlinks are not followed). */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await fs.lstat(full)).size;
  }
  return total;
}
