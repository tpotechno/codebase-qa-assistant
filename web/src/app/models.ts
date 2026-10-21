export interface AppConfig {
  repoName: string;
  repoPath: string;
  model: string;
  canPost: boolean;
  maxBudgetUsd: number;
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
