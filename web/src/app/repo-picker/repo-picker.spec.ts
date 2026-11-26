import { describe, expect, it } from 'vitest';
import { placeholderFor, repoStatus } from './repo-picker';

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
