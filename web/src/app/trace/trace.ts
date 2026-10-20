import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TraceStep } from '../models';
import { TOOL_LABELS } from '../tool-summary';

/**
 * The agent's steps, styled like a diff gutter: each tool call gets a number in the
 * gutter (the calls really are a sequence), notes sit between them unnumbered.
 */
@Component({
  selector: 'app-trace',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (steps().length === 0) {
      <p class="empty">{{ idleText() }}</p>
    } @else {
      <ol class="trace" [attr.aria-busy]="running()">
        @for (row of rows(); track row.step.id) {
          @if (row.step.kind === 'note') {
            <li class="note"><span class="gutter" aria-hidden="true"></span><p>{{ row.step.text }}</p></li>
          } @else {
            <li class="call" [class]="row.step.status">
              <span class="gutter">{{ row.n }}</span>
              <div class="body">
                <div class="head">
                  <span class="tool">{{ label(row.step.tool) }}</span>
                  <span class="status" [attr.aria-label]="statusText(row.step.status)">{{ statusGlyph(row.step.status) }}</span>
                </div>
                <code class="summary">{{ row.step.summary }}</code>
                @if (row.step.preview) {
                  <details>
                    <summary>Result</summary>
                    <pre>{{ row.step.preview }}</pre>
                  </details>
                }
              </div>
            </li>
          }
        }
      </ol>
    }
  `,
  styleUrl: './trace.scss',
})
export class Trace {
  readonly steps = input.required<TraceStep[]>();
  readonly running = input(false);
  readonly idleText = input('Steps appear here as the assistant works.');

  /** Number only the tool calls; notes don't take a number. */
  protected readonly rows = computed(() => {
    let n = 0;
    return this.steps().map((step) => ({ step, n: step.kind === 'tool' ? ++n : 0 }));
  });

  protected label(tool: string): string {
    return TOOL_LABELS[tool] ?? tool;
  }
  protected statusGlyph(s: string): string {
    return s === 'ok' ? '✓' : s === 'error' ? '!' : '';
  }
  protected statusText(s: string): string {
    return s === 'ok' ? 'Done' : s === 'error' ? 'Failed' : 'Running';
  }
}
