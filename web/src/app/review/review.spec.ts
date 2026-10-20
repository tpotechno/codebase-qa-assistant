import { describe, expect, it } from 'vitest';
import { groupByFile, postedText, severityCounts } from './review';
import { ReviewComment } from '../models';

const c = (path: string, line: number, severity: ReviewComment['severity']): ReviewComment => ({ path, line, severity, body: 'x' });

describe('review helpers', () => {
  it('groups comments by file in first-mention order, sorted by line', () => {
    const groups = groupByFile([c('b.ts', 9, 'nit'), c('a.ts', 3, 'blocker'), c('b.ts', 2, 'suggestion')]);
    expect(groups.map((g) => g.path)).toEqual(['b.ts', 'a.ts']);
    expect(groups[0].comments.map((x) => x.line)).toEqual([2, 9]);
  });

  it('summarizes severities, most severe first, skipping empty ones', () => {
    expect(severityCounts([c('a', 1, 'nit'), c('a', 2, 'blocker'), c('a', 3, 'nit')])).toBe('1 blocker, 2 nits');
    expect(severityCounts([])).toBe('');
  });

  it('describes what was posted', () => {
    expect(postedText({ url: 'u', inlineCount: 1, foldedCount: 0 })).toBe('Posted, with 1 inline comment.');
    expect(postedText({ url: 'u', inlineCount: 3, foldedCount: 2 })).toBe('Posted, with 3 inline comments and 2 moved into the summary.');
  });
});
