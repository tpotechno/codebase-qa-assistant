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
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
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
  for (const raw of patch.split("\n")) {
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
    } else {
      commentableLines.add(newLine);
      out.push(`${String(newLine).padStart(5)}   ${body}`);
      newLine++;
    }
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
}

const MAX_FILE_PAGES = 30; // GitHub caps the files endpoint at 3,000 files (30 x 100)

export class GitHubClient {
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: GitHubClientOptions = {}) {
    this.token = opts.token || undefined;
    this.baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
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

  async getPr(ref: PrRef): Promise<PrSummary> {
    const base = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
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
  async postReview(ref: PrRef, body: string, comments: ReviewComment[]): Promise<PostReviewResult> {
    const pr = await this.getPr(ref);
    const lineSets = new Map(pr.files.map((f) => [f.filename, parsePatch(f.patch).commentableLines]));

    const inline: Array<ReviewComment & { side: "RIGHT" }> = [];
    const folded: ReviewComment[] = [];
    for (const c of comments) {
      if (lineSets.get(c.path)?.has(c.line)) inline.push({ ...c, side: "RIGHT" });
      else folded.push(c);
    }

    let fullBody = body;
    if (folded.length) {
      fullBody +=
        "\n\n**Additional notes** (lines outside the diff)\n\n" +
        folded.map((c) => `- \`${c.path}:${c.line}\` ${c.body}`).join("\n");
    }

    const review = await this.request<{ html_url: string }>(
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
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

/**
 * Annotated diffs, paged by size so a large PR never floods the context window.
 * Pass `path` for one file; otherwise files are packed into pages of ~24k characters.
 */
export function formatPrDiff(pr: PrSummary, opts: { path?: string; page?: number } = {}): string {
  let files = pr.files;
  if (opts.path) {
    files = files.filter((f) => f.filename === opts.path);
    if (!files.length) return `Error: "${opts.path}" is not one of the files changed in ${formatPrRef(pr.ref)}.`;
  }

  const sections = files.map((f) => `=== ${f.filename} (${f.status}, +${f.additions} -${f.deletions}) ===\n${parsePatch(f.patch).annotated}`);
  const pages: string[][] = [[]];
  let size = 0;
  for (const s of sections) {
    if (size > 0 && size + s.length > DIFF_PAGE_CHARS) {
      pages.push([]);
      size = 0;
    }
    pages[pages.length - 1].push(s.length > DIFF_PAGE_CHARS ? `${s.slice(0, DIFF_PAGE_CHARS)}\n… [file diff truncated]` : s);
    size += Math.min(s.length, DIFF_PAGE_CHARS);
  }

  const page = Math.min(Math.max(opts.page ?? 1, 1), pages.length);
  const header =
    "Line numbers are new-file (RIGHT side) lines; only numbered lines can take inline comments.\n" +
    `Page ${page} of ${pages.length}${page < pages.length ? ` — call again with page=${page + 1} for more` : ""}.\n`;
  return `${header}\n${pages[page - 1].join("\n\n")}`;
}
