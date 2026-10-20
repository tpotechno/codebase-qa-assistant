import { Pipe, PipeTransform } from '@angular/core';
import { marked } from 'marked';

marked.use({ gfm: true, breaks: false });

/**
 * Markdown to HTML for model output. The result is bound with [innerHTML], which Angular
 * sanitizes, so scripts and event handlers in model output are stripped.
 */
@Pipe({ name: 'markdown' })
export class MarkdownPipe implements PipeTransform {
  transform(text: string | null | undefined): string {
    return text ? (marked.parse(text, { async: false }) as string) : '';
  }
}
