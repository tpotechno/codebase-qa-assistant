/**
 * Minimal GitHub REST client for pull-request review.
 *
 * Only the handful of endpoints the review tools need, with fetch injected so the
 * client is fully testable offline. Reviews are always posted with event "COMMENT":
 * the assistant never approves or blocks a PR on its own.
 */

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** Accepts "owner/repo#123", "owner/repo/123", or a github.com pull-request URL. */
export function parsePrRef(input: string): PrRef {
  const s = input.trim();
  const url = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i.exec(s);
  const short = /^([\w.-]+)\/([\w.-]+)(?:#|\/)(\d+)$/.exec(s);
  const m = url ?? short;
  if (!m) throw new Error(`Not a pull request reference: "${input}". Use owner/repo#123 or a PR URL.`);
  // "." and ".." are valid characters but would let URL normalization redirect an
  // authenticated request (including a POST) to a different API path.
  if (/^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) {
    throw new Error(`Not a pull request reference: "${input}" (owner and repo can't be "." or "..").`);
  }
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** API path for a PR, with each segment encoded as defense in depth. */
const prPath = (r: PrRef) =>
  `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/pulls/${Number(r.number)}`;

/** Pull the 40-character head SHA out of formatPrSummary output (undefined if absent). */
export function extractHeadSha(summary: string): string | undefined {
  return /^Head: ([0-9a-f]{40})\b/m.exec(summary)?.[1];
}

/**
 * Review text comes from a model reading untrusted PR content, and is posted under the
 * user's token. Wrap @mentions in code spans so a prompt-injected PR can't make the
 * review ping people or teams. (Email addresses are untouched.)
 */
export function neutralizeMentions(text: string): string {
  return text.replace(/(^|[^\w`@])@([A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9_.-]+)?)/g, "$1`@$2`");
}

export const formatPrRef = (r: PrRef) => `${r.owner}/${r.repo}#${r.number}`;

// ---------- Diff parsing ----------

export interface ParsedPatch {
  /** New-file (RIGHT side) line numbers GitHub accepts inline comments on. */
  commentableLines: Set<number>;
  /** Patch with new-file line numbers in a gutter, so the model can cite exact lines. */
  annotated: string;
}

/**
 * Walk a unified-diff patch. Added (+) and context ( ) lines exist in the new file and
 * can carry inline review comments; removed (-) lines do not.
 */
export function parsePatch(patch: string | undefined): ParsedPatch {
  const commentableLines = new Set<number>();
  if (!patch) return { commentableLines, annotated: "(no textual diff: binary, too large, or rename only)" };

  const out: string[] = [];
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const raw = line.replace(/\r$/, "");
    // A real context line is " " (a space), never empty. Empty strings only come from a
    // trailing newline or CRLF artifacts and must not create phantom commentable lines.
    if (raw === "") continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      out.push(raw);
      continue;
    }
    const tag = raw[0];
    const body = raw.slice(1);
    if (tag === "+") {
      commentableLines.add(newLine);
      out.push(`${String(newLine).padStart(5)} + ${body}`);
      newLine++;
    } else if (tag === "-") {
      out.push(`      - ${body}`);
    } else if (tag === "\\") {
      out.push(`        ${raw}`); // "\ No newline at end of file"
    } else if (tag === " ") {
      commentableLines.add(newLine);
      out.push(`${String(newLine).padStart(5)}   ${body}`);
      newLine++;
    }
    // Anything else is not valid unified-diff content; skip it rather than miscount lines.
  }
  return { commentableLines, annotated: out.join("\n") };
}

// ---------- Client ----------

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

export interface PrSummary {
  ref: PrRef;
  title: string;
  body: string;
  author: string;
  state: string;
  draft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  url: string;
  files: PrFile[];
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface PostReviewResult {
  url: string;
  inlineCount: number;
  /** Comments whose line wasn't part of the diff; folded into the review body instead. */
  foldedCount: number;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  token?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** How long a fetched PR is reused, so paging through a diff doesn't refetch it. Default 60s. */
  cacheTtlMs?: number;
}

const MAX_CACHED_PRS = 50;
const MAX_FILE_PAGES = 30; // GitHub caps the files endpoint at 3,000 files (30 x 100)

export class GitHubClient {
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { at: number; pr: Promise<PrSummary> }>();

  constructor(opts: GitHubClientOptions = {}) {
    this.token = opts.token || undefined;
    this.baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
  }

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "codebase-qa-assistant",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { message?: string; errors?: unknown };
        detail = j.message ?? "";
        if (j.errors) detail += ` ${JSON.stringify(j.errors)}`;
      } catch {
        /* non-JSON error body */
      }
      const hint =
        res.status === 404 ? " (check the PR exists; private repos need GITHUB_TOKEN)"
        : res.status === 401 ? " (GITHUB_TOKEN is invalid or expired)"
        : res.status === 403 ? " (rate limited or token lacks permission; set GITHUB_TOKEN)"
        : "";
      throw new Error(`GitHub ${res.status} on ${path}: ${detail}${hint}`.trim());
    }
    return (await res.json()) as T;
  }

  /**
   * Fetch a PR with its changed files. Results are cached briefly (keyed by PR) so a review
   * that pages through the diff costs one fetch instead of one per page, which matters under
   * GitHub's 60-requests-per-hour unauthenticated limit, and so every page comes from the same
   * snapshot. Concurrent calls share one in-flight request. Pass fresh to bypass the cache.
   */
  async getPr(ref: PrRef, opts: { fresh?: boolean } = {}): Promise<PrSummary> {
    const key = formatPrRef(ref).toLowerCase();
    const hit = this.cache.get(key);
    if (!opts.fresh && hit && Date.now() - hit.at < this.cacheTtlMs) return hit.pr;

    const now = Date.now();
    for (const [k, v] of this.cache) if (now - v.at >= this.cacheTtlMs) this.cache.delete(k);
    while (this.cache.size >= MAX_CACHED_PRS) this.cache.delete(this.cache.keys().next().value!);

    const pr = this.fetchPr(ref);
    this.cache.set(key, { at: now, pr });
    pr.catch(() => {
      if (this.cache.get(key)?.pr === pr) this.cache.delete(key);
    });
    return pr;
  }

  private async fetchPr(ref: PrRef): Promise<PrSummary> {
    const base = prPath(ref);
    const pr = await this.request<any>(base);
    const files: PrFile[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const batch = await this.request<PrFile[]>(`${base}/files?per_page=100&page=${page}`);
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return {
      ref,
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      state: pr.merged_at ? "merged" : pr.state,
      draft: Boolean(pr.draft),
      baseRef: pr.base?.ref,
      headRef: pr.head?.ref,
      headSha: pr.head?.sha,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      url: pr.html_url,
      files,
    };
  }

  /**
   * Post a review as a single COMMENT. Inline comments on lines outside the diff would
   * make GitHub reject the whole review (HTTP 422), so they are validated first and any
   * that don't fit are folded into the review body rather than lost.
   */
  async postReview(
    ref: PrRef,
    body: string,
    comments: ReviewComment[],
    opts: { expectedHeadSha?: string } = {},
  ): Promise<PostReviewResult> {
    // Always fresh: line validation and commit_id must match the PR as it is right now.
    const pr = await this.getPr(ref, { fresh: true });
    if (opts.expectedHeadSha && opts.expectedHeadSha !== pr.headSha) {
      throw new Error(
        `The PR has new commits since it was reviewed (reviewed ${opts.expectedHeadSha.slice(0, 7)}, ` +
          `now ${pr.headSha.slice(0, 7)}). Re-run the review so comments land on the right lines.`,
      );
    }
    const lineSets = new Map(pr.files.map((f) => [f.filename, parsePatch(f.patch).commentableLines]));

    const inline: Array<ReviewComment & { side: "RIGHT" }> = [];
    const folded: ReviewComment[] = [];
    for (const raw of comments) {
      const c = { ...raw, body: neutralizeMentions(raw.body) };
      if (lineSets.get(c.path)?.has(c.line)) inline.push({ ...c, side: "RIGHT" });
      else folded.push(c);
    }

    let fullBody = neutralizeMentions(body);
    if (folded.length) {
      fullBody +=
        "\n\n**Additional notes** (lines outside the diff)\n\n" +
        folded.map((c) => `- \`${c.path}:${c.line}\` ${c.body}`).join("\n");
    }

    const review = await this.request<{ html_url: string }>(
      `${prPath(ref)}/reviews`,
      {
        method: "POST",
        body: JSON.stringify({ commit_id: pr.headSha, event: "COMMENT", body: fullBody, comments: inline }),
      },
    );
    return { url: review.html_url, inlineCount: inline.length, foldedCount: folded.length };
  }
}

// ---------- LLM-facing formatting ----------

export function formatPrSummary(pr: PrSummary): string {
  const body = pr.body.length > 2_000 ? `${pr.body.slice(0, 2_000)}…` : pr.body;
  const files = pr.files
    .map((f) => {
      const renamed = f.previous_filename ? ` (from ${f.previous_filename})` : "";
      return `  ${f.status.padEnd(9)} +${f.additions} -${f.deletions}  ${f.filename}${renamed}`;
    })
    .join("\n");
  return [
    `${formatPrRef(pr.ref)}: ${pr.title}`,
    `Author: ${pr.author} | State: ${pr.state}${pr.draft ? " (draft)" : ""} | ${pr.headRef} -> ${pr.baseRef}`,
    `Head: ${pr.headSha} | +${pr.additions} -${pr.deletions} across ${pr.changedFiles} file(s)`,
    `URL: ${pr.url}`,
    "",
    "Description:",
    body || "(none)",
    "",
    "Changed files:",
    files || "  (none)",
  ].join("\n");
}

const DIFF_PAGE_CHARS = 24_000;
const PART_CHARS = DIFF_PAGE_CHARS - 500; // leave room for the section header
const MAX_LINE_CHARS = 2_000; // e.g. a minified line; keeps any single line from exceeding a page

/** Lockfiles, minified bundles, and similar: rarely worth review tokens. */
const GENERATED = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/,
  /\.min\.(js|css)$/,
  /\.(map|snap)$/,
];
export const isGeneratedFile = (path: string) => GENERATED.some((re) => re.test(path));

/**
 * Annotated diffs, paged by size so a large PR never floods the context window.
 * Pass `path` for one file; otherwise files are packed into pages of ~24k characters.
 * Files larger than a page are split into parts at line boundaries rather than truncated.
 */
export function formatPrDiff(pr: PrSummary, opts: { path?: string; page?: number } = {}): string {
  let files = pr.files;
  if (opts.path) {
    files = files.filter((f) => f.filename === opts.path);
    if (!files.length) return `Error: "${opts.path}" is not one of the files changed in ${formatPrRef(pr.ref)}.`;
  }

  // Each file becomes one or more sections. A file too big for one page is split at line
  // boundaries into numbered parts, so every line stays reachable by paging.
  const sections: string[] = [];
  for (const f of files) {
    const label = `${f.filename} (${f.status}, +${f.additions} -${f.deletions})`;
    if (!opts.path && isGeneratedFile(f.filename)) {
      sections.push(`=== ${label} ===\n(generated file; diff omitted. Request it with path="${f.filename}" if it matters.)`);
      continue;
    }
    const lines = parsePatch(f.patch).annotated.split("\n").map((l) =>
      l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)} … [line shortened]` : l,
    );
    const parts: string[][] = [[]];
    let partSize = 0;
    for (const l of lines) {
      if (partSize > 0 && partSize + l.length + 1 > PART_CHARS) {
        parts.push([]);
        partSize = 0;
      }
      parts[parts.length - 1].push(l);
      partSize += l.length + 1;
    }
    parts.forEach((p, i) => {
      const suffix = parts.length > 1 ? ` [part ${i + 1} of ${parts.length}]` : "";
      sections.push(`=== ${label}${suffix} ===\n${p.join("\n")}`);
    });
  }

  const pages: string[][] = [[]];
  let size = 0;
  for (const s of sections) {
    if (size > 0 && size + s.length > DIFF_PAGE_CHARS) {
      pages.push([]);
      size = 0;
    }
    pages[pages.length - 1].push(s);
    size += s.length;
  }

  const page = Math.min(Math.max(opts.page ?? 1, 1), pages.length);
  const header =
    "Line numbers are new-file (RIGHT side) lines; only numbered lines can take inline comments.\n" +
    `Page ${page} of ${pages.length}${page < pages.length ? ` — call again with page=${page + 1} for more` : ""}.\n`;
  return `${header}\n${pages[page - 1].join("\n\n")}`;
}
