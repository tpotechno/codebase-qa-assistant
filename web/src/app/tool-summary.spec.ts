import { describe, expect, it } from 'vitest';
import { summarizeTool } from './tool-summary';

describe('summarizeTool', () => {
  it('describes each tool in a short, readable way', () => {
    expect(summarizeTool('search_code', { query: 'allowedTools', path_glob: 'src/' })).toBe('“allowedTools” in src/');
    expect(summarizeTool('search_docs', { query: 'MCP' })).toBe('“MCP”');
    expect(summarizeTool('read_file', { path: 'src/a.ts', start: 10, end: 40 })).toBe('src/a.ts:10–40');
    expect(summarizeTool('read_file', { path: 'src/a.ts' })).toBe('src/a.ts');
    expect(summarizeTool('get_pr', { pr: 'acme/widgets#7' })).toBe('acme/widgets#7');
    expect(summarizeTool('get_pr_diff', { pr: 'acme/widgets#7', path: 'x.ts', page: 2 })).toBe('acme/widgets#7, x.ts, page 2');
  });

  it('falls back to JSON for unknown tools', () => {
    expect(summarizeTool('other', { a: 1 })).toBe('{"a":1}');
  });
});
