import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Api } from '../api';
import { MarkdownPipe } from '../markdown.pipe';
import { AppConfig, TraceStep } from '../models';
import { SseEvent } from '../sse';
import { summarizeTool } from '../tool-summary';
import { Trace } from '../trace/trace';

interface AskStats {
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

@Component({
  selector: 'app-ask',
  imports: [DecimalPipe, FormsModule, MarkdownPipe, Trace],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ask.html',
  styleUrl: './ask.scss',
})
export class Ask {
  private readonly api = inject(Api);
  readonly config = input<AppConfig | null>(null);

  protected readonly draft = signal('');
  protected readonly asked = signal('');
  protected readonly answer = signal('');
  protected readonly steps = signal<TraceStep[]>([]);
  protected readonly running = signal(false);
  protected readonly error = signal('');
  protected readonly stats = signal<AskStats | null>(null);

  /** The demo answers one scripted question, so it suggests only that one. */
  protected readonly suggestions = computed(() =>
    this.config()?.demo
      ? ['How does the review agent stay read-only?']
      : [
          'Give me a short tour of this codebase.',
          'Where is configuration loaded, and what can be configured?',
          'What are the riskiest parts of this code, and why?',
        ],
  );

  private controller: AbortController | null = null;
  private turn = 0;
  private turnText = '';
  private notedTurns = new Set<number>();

  protected useSuggestion(text: string): void {
    this.draft.set(text);
    void this.submit();
  }

  protected onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void this.submit();
    }
  }

  async submit(): Promise<void> {
    const question = this.draft().trim();
    if (!question || this.running()) return;

    this.asked.set(question);
    this.answer.set('');
    this.steps.set([]);
    this.error.set('');
    this.stats.set(null);
    this.turn = 0;
    this.turnText = '';
    this.notedTurns.clear();
    this.running.set(true);
    this.controller = new AbortController();

    try {
      await this.api.stream('/api/ask', { question }, (e) => this.handle(e), this.controller.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.error.set((e as Error).message);
    } finally {
      this.markUnfinished();
      this.running.set(false);
      this.controller = null;
    }
  }

  protected stop(): void {
    this.controller?.abort();
    this.error.set('Stopped. Nothing more will be spent on this question.');
  }

  private handle(e: SseEvent): void {
    switch (e.event) {
      case 'text': {
        if (e.data.turn !== this.turn) {
          this.turn = e.data.turn;
          this.turnText = '';
        }
        this.turnText += e.data.delta;
        this.answer.set(this.turnText);
        break;
      }
      case 'tool_call': {
        // Text written before a tool call is a working note, not the answer: move it to the trace.
        if (this.turnText.trim() && !this.notedTurns.has(this.turn)) {
          this.notedTurns.add(this.turn);
          this.steps.update((s) => [...s, { kind: 'note', id: `note-${this.turn}`, text: this.turnText.trim() }]);
          this.answer.set('');
        }
        const { id, name, input } = e.data;
        this.steps.update((s) => [...s, { kind: 'tool', id, tool: name, summary: summarizeTool(name, input), status: 'running' }]);
        break;
      }
      case 'tool_result':
        this.steps.update((s) =>
          s.map((step) =>
            step.kind === 'tool' && step.id === e.data.id
              ? { ...step, status: e.data.isError ? 'error' : 'ok', preview: e.data.preview }
              : step,
          ),
        );
        break;
      case 'done':
        this.answer.set(e.data.answer);
        this.stats.set({
          turns: e.data.turns,
          toolCalls: e.data.toolCalls,
          inputTokens: e.data.usage.inputTokens,
          outputTokens: e.data.usage.outputTokens,
        });
        break;
      case 'error':
        this.error.set(e.data.message);
        break;
    }
  }

  /** If the run ended early, nothing is still "running". */
  private markUnfinished(): void {
    this.steps.update((s) => s.map((step) => (step.kind === 'tool' && step.status === 'running' ? { ...step, status: 'error' } : step)));
  }
}
