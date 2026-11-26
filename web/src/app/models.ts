export interface AppConfig {
  repoName: string;
  repoPath: string;
  model: string;
  canPost: boolean;
  maxBudgetUsd: number;
  /** Scripted demo: no model calls, a sample PR, nothing reaches GitHub. */
  demo?: boolean;
  /** GitHub username when hosted behind sign-in; null when running locally. */
  user?: string | null;
  /** Which other codebases the server can open; both false (or missing) hides the field. */
  repoChoice?: { local: boolean; github: boolean };
}

/** A codebase opened with POST /api/repo (shape of RepoInfo in src/repos.ts). */
export interface RepoInfo {
  /** Sent with each question as repoId. */
  id: string;
  name: string;
  /** The folder path, or owner/repo@branch. */
  label: string;
  kind: 'local' | 'github';
  /** Commit that was downloaded (GitHub only). */
  sha?: string;
  url?: string;
}

export type StepStatus = 'running' | 'ok' | 'error';

/** One entry in the trace: a tool call, or a short note Claude wrote before calling tools. */
export type TraceStep =
  | { kind: 'tool'; id: string; tool: string; summary: string; status: StepStatus; preview?: string }
  | { kind: 'note'; id: string; text: string };

export type Severity = 'blocker' | 'suggestion' | 'nit';
export type Verdict = 'looks_good' | 'minor_issues' | 'needs_changes';

export interface ReviewComment {
  path: string;
  line: number;
  severity: Severity;
  body: string;
}

export interface Review {
  summary: string;
  verdict: Verdict;
  comments: ReviewComment[];
}

export interface PostResult {
  url: string;
  inlineCount: number;
  foldedCount: number;
}
