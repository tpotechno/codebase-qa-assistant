import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../api';
import { AppConfig, RepoInfo } from '../models';
import { placeholderFor, repoStatus, RepoPicker } from './repo-picker';

describe('repo picker helpers', () => {
  it('suggests only the kinds of location the server accepts', () => {
    expect(placeholderFor({ local: true, github: true })).toBe('C:\\source\\repos\\my-app or owner/repo');
    expect(placeholderFor({ local: true, github: false })).toBe('C:\\source\\repos\\my-app');
    expect(placeholderFor({ local: false, github: true })).toContain('owner/repo@branch');
  });

  it('describes the chosen codebase, with the short commit for a GitHub clone', () => {
    expect(repoStatus({ id: 'x', name: 'app', label: 'C:\\src\\app', kind: 'local' })).toBe('C:\\src\\app');
    expect(
      repoStatus({
        id: 'x',
        name: 'acme/widgets',
        label: 'acme/widgets@main',
        kind: 'github',
        sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      }),
    ).toBe('acme/widgets@main (a1b2c3d)');
  });
});

const config = (repoChoice: AppConfig['repoChoice']): AppConfig => ({
  repoName: 'codebase-qa-assistant',
  repoPath: '/srv/app',
  model: 'm',
  canPost: false,
  maxBudgetUsd: 1,
  repoChoice,
});

const widgets: RepoInfo = {
  id: '6f1d2c3b-4a59-4e8d-9c7b-1a2b3c4d5e6f',
  name: 'acme/widgets',
  label: 'acme/widgets@main',
  kind: 'github',
  sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  url: 'https://github.com/acme/widgets',
};

describe('RepoPicker', () => {
  // The only Api call the picker makes; each test decides how it answers.
  const openRepo = vi.fn<(location: string, signal: AbortSignal) => Promise<RepoInfo>>();

  beforeEach(() => {
    openRepo.mockReset();
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [{ provide: Api, useValue: { openRepo } }] });
  });
  afterEach(() => localStorage.clear());

  async function render(choice: AppConfig['repoChoice'] = { local: true, github: true }) {
    const fixture = TestBed.createComponent(RepoPicker);
    fixture.componentRef.setInput('config', config(choice));
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const input = () => el.querySelector('input') as HTMLInputElement;
    const type = async (text: string) => {
      input().value = text;
      input().dispatchEvent(new Event('input'));
      await fixture.whenStable();
    };
    const submit = async () => {
      el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await fixture.whenStable();
    };
    return { fixture, el, input, type, submit };
  }

  it('is hidden when the server opens no other codebases', async () => {
    const { el } = await render({ local: false, github: false });
    expect(el.querySelector('input')).toBeNull();
  });

  it('opens a location, reports it, and remembers what was typed', async () => {
    openRepo.mockResolvedValue(widgets);
    const { fixture, el, type, submit } = await render();
    expect(el.textContent).toContain('Asking about codebase-qa-assistant');

    await type('  acme/widgets  ');
    await submit();

    expect(openRepo).toHaveBeenCalledWith('acme/widgets', expect.any(AbortSignal));
    expect(fixture.componentInstance.repo()).toEqual(widgets);
    const link = el.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toContain('acme/widgets@main (a1b2c3d)');
    expect(link.href).toBe('https://github.com/acme/widgets');
    expect(localStorage.getItem('codebase-qa.location')).toBe('acme/widgets');
  });

  it('shows the server’s refusal and keeps the current codebase', async () => {
    openRepo.mockRejectedValue(new Error('Only public repositories can be opened here.'));
    const { fixture, el, type, submit } = await render();
    await type('acme/secret');
    await submit();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Only public repositories');
    expect(fixture.componentInstance.repo()).toBeNull();
    expect(localStorage.getItem('codebase-qa.location')).toBeNull();
  });

  it('can cancel a slow download without showing an error', async () => {
    // Rejects with an AbortError when its signal fires, as fetch does.
    openRepo.mockImplementation(
      (_l, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
        ),
    );
    const { fixture, el, type, submit } = await render();
    await type('acme/huge');
    void submit();
    await fixture.whenStable();
    expect(el.textContent).toContain('Opening…');

    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Cancel')) as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(el.textContent).not.toContain('Opening…');
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('goes back to the built-in codebase', async () => {
    openRepo.mockResolvedValue(widgets);
    const { fixture, el, type, submit } = await render();
    await type('acme/widgets');
    await submit();
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('back to')) as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(fixture.componentInstance.repo()).toBeNull();
    expect(el.textContent).toContain('Asking about codebase-qa-assistant');
  });

  it('prefills the last location but never opens it by itself', async () => {
    localStorage.setItem('codebase-qa.location', 'acme/widgets');
    const { input } = await render();
    expect(input().value).toBe('acme/widgets');
    expect(openRepo).not.toHaveBeenCalled();
  });

  it('is locked while a question is running', async () => {
    const { fixture, input } = await render();
    fixture.componentRef.setInput('disabled', true);
    await fixture.whenStable();
    expect(input().disabled).toBe(true);
  });
});
