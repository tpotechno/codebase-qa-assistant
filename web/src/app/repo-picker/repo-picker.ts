import { ChangeDetectionStrategy, Component, computed, inject, input, model, signal } from '@angular/core';
import { Api } from '../api';
import { AppConfig, RepoInfo } from '../models';

type Choice = NonNullable<AppConfig['repoChoice']>;

/** The example shown in the field, matching what this server accepts. */
export function placeholderFor(choice: Choice): string {
  if (choice.local && choice.github) return 'C:\\source\\repos\\my-app or owner/repo';
  if (choice.local) return 'C:\\source\\repos\\my-app';
  return 'owner/repo, owner/repo@branch or a github.com URL';
}

/** One line describing the codebase questions go to, e.g. "acme/widgets@main (a1b2c3d)". */
export function repoStatus(repo: RepoInfo): string {
  return repo.sha ? `${repo.label} (${repo.sha.slice(0, 7)})` : repo.label;
}

// Remembers the last location typed, so it's ready next visit. Never loaded automatically:
// opening a GitHub repo downloads it, which should only happen when the person asks.
const STORAGE_KEY = 'codebase-qa.location';

function readSaved(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return ''; // storage blocked (private window, site data off)
  }
}

function save(location: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, location);
  } catch {
    /* a convenience only */
  }
}

/**
 * Chooses which codebase Ask works on. The server checks every location against its own
 * policy (local folders, GitHub, size limits), so this only collects and reports.
 */
@Component({
  selector: 'app-repo-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './repo-picker.html',
  styleUrl: './repo-picker.scss',
})
export class RepoPicker {
  private readonly api = inject(Api);
  readonly config = input<AppConfig | null>(null);
  /** True while a question is running, so the codebase can't change under it. */
  readonly disabled = input(false);
  /** The chosen codebase; null means the server's built-in one. */
  readonly repo = model<RepoInfo | null>(null);

  protected readonly location = signal(readSaved());
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  protected readonly choice = computed<Choice>(
    () => this.config()?.repoChoice ?? { local: false, github: false },
  );
  protected readonly available = computed(() => this.choice().local || this.choice().github);
  protected readonly placeholder = computed(() => placeholderFor(this.choice()));
  protected readonly status = computed(() => {
    const repo = this.repo();
    return repo ? repoStatus(repo) : (this.config()?.repoName ?? 'this codebase');
  });

  private controller: AbortController | null = null;

  protected onInput(e: Event): void {
    this.location.set((e.target as HTMLInputElement).value);
  }

  /** Enter in the field or the Open button; the page itself never navigates. */
  protected onSubmit(e: Event): void {
    e.preventDefault();
    void this.open();
  }

  async open(): Promise<void> {
    const location = this.location().trim();
    if (!location || this.loading()) return;
    this.error.set('');
    this.loading.set(true);
    this.controller = new AbortController();
    try {
      this.repo.set(await this.api.openRepo(location, this.controller.signal));
      save(location);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.error.set((e as Error).message);
    } finally {
      this.loading.set(false);
      this.controller = null;
    }
  }

  protected cancel(): void {
    this.controller?.abort();
  }

  /** Go back to the server's built-in codebase. */
  protected useDefault(): void {
    this.repo.set(null);
    this.error.set('');
  }
}
