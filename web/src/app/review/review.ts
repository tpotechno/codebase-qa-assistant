import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../api';
import { MarkdownPipe } from '../markdown.pipe';
import { AppConfig, PostResult, Review as ReviewData, ReviewComment, Severity, TraceStep, Verdict } from '../models';
import { SseEvent } from '../sse';
import { summarizeTool } from '../tool-summary';
import { Trace } from '../trace/trace';

interface StartedPr {
  pr: string;
  title: string;
  url: string;
  headSha: string;
  files: number;
}

interface ReviewStats {
  costUsd: number;
  turns: number;
  durationMs: number;
}

type PostState = 'idle' | 'confirm' | 'posting' | 'posted';

const SEVERITY_ORDER: Severity[] = ['blocker', 'suggestion', 'nit'];

/** Comments grouped by file, files in first-mention order, comments by line. */
export function groupByFile(comments: ReviewComment[]): { path: string; comments: ReviewComment[] }[] {
  const groups = new Map<string, ReviewComment[]>();
  for (const c of comments) groups.set(c.path, [...(groups.get(c.path) ?? []), c]);
  return [...groups].map(([path, list]) => ({ path, comments: [...list].sort((a, b) => a.line - b.line) }));
}

export function postedText(p: PostResult): string {
  const inline = `${p.inlineCount} inline ${p.inlineCount === 1 ? 'comment' : 'comments'}`;
  const folded = p.foldedCount ? ` and ${p.foldedCount} moved into the summary` : '';
  return `Posted, with ${inline}${folded}.`;
}

export function severityCounts(comments: ReviewComment[]): string {
  return SEVERITY_ORDER.map((s) => [s, comments.filter((c) => c.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}${n === 1 ? '' : 's'}`)
    .join(', ');
}

@Component({
  selector: 'app-review',
  imports: [FormsModule, MarkdownPipe, Trace],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './review.html',
  styleUrl: './review.scss',
})
export class Review {
  private readonly api = inject(Api);
  readonly config = input<AppConfig | null>(null);

  protected readonly draft = signal('');
  protected readonly started = signal<StartedPr | null>(null);
  protected readonly steps = signal<TraceStep[]>([]);
  protected readonly review = signal<ReviewData | null>(null);
  protected readonly stats = signal<ReviewStats | null>(null);
  protected readonly running = signal(false);
  protected readonly error = signal('');
  protected readonly submitted = signal(false);

  protected readonly postState = signal<PostState>('idle');
  protected readonly postResult = signal<PostResult | null>(null);
  protected readonly postError = signal('');

  protected readonly files = computed(() => groupByFile(this.review()?.comments ?? []));
  protected readonly counts = computed(() => severityCounts(this.review()?.comments ?? []));

  protected readonly verdictText: Record<Verdict, string> = {
    looks_good: 'Looks good',
    minor_issues: 'Minor issues',
    needs_changes: 'Needs changes',
  };

  protected readonly postedText = postedText;
  protected readonly samplePr = 'acme/widgets#7';

  protected useSample(): void {
    this.draft.set(this.samplePr);
    void this.submit();
  }

  private controller: AbortController | null = null;
  private stepCount = 0;
  private draftId = '';

  async submit(): Promise<void> {
    const pr = this.draft().trim();
    if (!pr || this.running()) return;

    this.submitted.set(true);
    this.started.set(null);
    this.steps.set([]);
    this.review.set(null);
    this.stats.set(null);
    this.error.set('');
    this.postState.set('idle');
    this.postResult.set(null);
    this.postError.set('');
    this.stepCount = 0;
    this.draftId = '';
    this.running.set(true);
    this.controller = new AbortController();

    try {
      await this.api.stream('/api/review', { pr }, (e) => this.handle(e), this.controller.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.error.set((e as Error).message);
    } finally {
      this.settleSteps(this.review() ? 'ok' : 'error');
      this.running.set(false);
      this.controller = null;
    }
  }

  protected stop(): void {
    this.controller?.abort();
    this.error.set('Stopped. Nothing more will be spent on this review.');
  }

  private handle(e: SseEvent): void {
    switch (e.event) {
      case 'started':
        this.started.set(e.data);
        break;
      case 'tool_call': {
        // The review agent reports calls, not results: a new call means the previous one finished.
        this.settleSteps('ok');
        const { name, input } = e.data;
        this.steps.update((s) => [
          ...s,
          { kind: 'tool', id: `step-${++this.stepCount}`, tool: name, summary: summarizeTool(name, input), status: 'running' },
        ]);
        break;
      }
      case 'done':
        this.review.set(e.data.review);
        this.draftId = e.data.draftId;
        this.stats.set({ costUsd: e.data.costUsd, turns: e.data.turns, durationMs: e.data.durationMs });
        break;
      case 'error':
        this.error.set(e.data.message);
        break;
    }
  }

  private settleSteps(status: 'ok' | 'error'): void {
    this.steps.update((s) => s.map((step) => (step.kind === 'tool' && step.status === 'running' ? { ...step, status } : step)));
  }

  protected async post(): Promise<void> {
    if (!this.draftId || this.postState() === 'posting') return;
    this.postState.set('posting');
    this.postError.set('');
    try {
      this.postResult.set(await this.api.postReview(this.draftId));
      this.postState.set('posted');
    } catch (e) {
      this.postError.set((e as Error).message);
      this.postState.set('confirm');
    }
  }
}
