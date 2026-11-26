import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../api';
import { AppConfig, RepoInfo } from '../models';
import { RepoPicker } from '../repo-picker/repo-picker';
import { Ask } from './ask';

const config: AppConfig = {
  repoName: 'codebase-qa-assistant',
  repoPath: '/srv/app',
  model: 'm',
  canPost: false,
  maxBudgetUsd: 1,
  repoChoice: { local: true, github: true },
};

const widgets: RepoInfo = { id: '6f1d2c3b-4a59-4e8d-9c7b-1a2b3c4d5e6f', name: 'acme/widgets', label: 'acme/widgets@main', kind: 'github' };

describe('Ask with a chosen codebase', () => {
  // Records what Ask sends; the stream ends straight away with a final answer.
  const stream = vi.fn(async (_path: string, _body: unknown, onEvent: (e: unknown) => void) => {
    onEvent({ event: 'done', data: { answer: 'ok', turns: 1, toolCalls: 0, usage: { inputTokens: 1, outputTokens: 1 } } });
  });

  beforeEach(() => {
    stream.mockClear();
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: { stream, openRepo: vi.fn() } }] });
  });

  async function render(cfg: AppConfig = config) {
    const fixture = TestBed.createComponent(Ask);
    fixture.componentRef.setInput('config', cfg);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const ask = async (question: string) => {
      const box = el.querySelector('textarea') as HTMLTextAreaElement;
      box.value = question;
      box.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      await fixture.componentInstance.submit();
      await fixture.whenStable();
    };
    // Choosing a codebase in the picker flows back to Ask through [(repo)].
    const choose = async (repo: RepoInfo | null) => {
      (fixture.debugElement.query(By.directive(RepoPicker)).componentInstance as RepoPicker).repo.set(repo);
      await fixture.whenStable();
    };
    return { el, ask, choose };
  }

  it('asks about the built-in codebase without a repoId', async () => {
    const { el, ask } = await render();
    expect(el.querySelector('label[for="question"]')?.textContent).toContain('Ask about codebase-qa-assistant');
    await ask('What is this?');
    expect(stream).toHaveBeenCalledWith('/api/ask', { question: 'What is this?' }, expect.any(Function), expect.any(AbortSignal));
  });

  it('sends the chosen codebase’s id with the question, and names it in the label', async () => {
    const { el, ask, choose } = await render();
    await choose(widgets);
    expect(el.querySelector('label[for="question"]')?.textContent).toContain('Ask about acme/widgets');
    await ask('What is this?');
    expect(stream).toHaveBeenCalledWith(
      '/api/ask',
      { question: 'What is this?', repoId: widgets.id },
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });

  it('in the demo, suggests the tour once another codebase is chosen', async () => {
    const { el, choose } = await render({ ...config, demo: true });
    expect(el.textContent).toContain('How does the review agent stay read-only?');
    await choose(widgets);
    expect(el.textContent).toContain('Give me a short tour of this codebase.');
    expect(el.textContent).not.toContain('How does the review agent stay read-only?');
  });
});
