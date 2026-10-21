import { Pipe, PipeTransform } from '@angular/core';
import { marked } from 'marked';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

marked.use({
  gfm: true,
  breaks: false,
  // Model output can quote text from PR diffs and comments, so raw HTML is shown as text,
  // never rendered. This is a first layer; Angular's [innerHTML] sanitizer is the second.
  renderer: {
    html: ({ text }) => escapeHtml(text),
  },
});

/**
 * Markdown to HTML for model output. Raw HTML in the input is escaped, and the result is
 * bound with [innerHTML], which Angular sanitizes. Never bind it with bypassSecurityTrustHtml.
 */
@Pipe({ name: 'markdown' })
export class MarkdownPipe implements PipeTransform {
  transform(text: string | null | undefined): string {
    return text ? (marked.parse(text, { async: false }) as string) : '';
  }
}
