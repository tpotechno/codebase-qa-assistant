import { describe, expect, it } from 'vitest';
import { MarkdownPipe } from './markdown.pipe';

describe('MarkdownPipe', () => {
  const md = new MarkdownPipe();

  it('renders Markdown', () => {
    expect(md.transform('**bold** and `code`')).toContain('<strong>bold</strong> and <code>code</code>');
  });

  it('shows raw HTML from model output as text instead of rendering it', () => {
    const out = md.transform('Look: <img src=x onerror="alert(1)"> and <script>alert(2)</script>');
    expect(out).not.toMatch(/<img|<script/i);
    expect(out).toContain('&lt;img');
    expect(out).toContain('&lt;script&gt;');
  });

  it('handles empty input', () => {
    expect(md.transform('')).toBe('');
    expect(md.transform(null)).toBe('');
  });
});
