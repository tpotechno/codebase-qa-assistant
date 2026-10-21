import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { Trace } from './trace';
import { TraceStep } from '../models';

describe('Trace', () => {
  it('numbers tool calls only, and shows status and notes', async () => {
    const steps: TraceStep[] = [
      { kind: 'note', id: 'n1', text: 'Looking for the config loader.' },
      { kind: 'tool', id: 'a', tool: 'search_code', summary: '“dotenv”', status: 'ok', preview: 'src/index.ts:1' },
      { kind: 'tool', id: 'b', tool: 'read_file', summary: 'src/index.ts', status: 'running' },
    ];
    const fixture = TestBed.createComponent(Trace);
    fixture.componentRef.setInput('steps', steps);
    fixture.componentRef.setInput('running', true);
    await fixture.whenStable();

    const el: HTMLElement = fixture.nativeElement;
    const gutters = [...el.querySelectorAll('li.call .gutter')].map((g) => g.textContent?.trim());
    expect(gutters).toEqual(['1', '2']);
    expect(el.querySelector('li.note')?.textContent).toContain('Looking for the config loader.');
    expect(el.querySelector('li.call.ok .tool')?.textContent).toBe('Search code');
    expect(el.querySelector('li.call.running .status')?.getAttribute('aria-label')).toBe('Running');
    expect(el.querySelector('ol')?.getAttribute('aria-busy')).toBe('true');
  });

  it('shows the idle text when there are no steps yet', async () => {
    const fixture = TestBed.createComponent(Trace);
    fixture.componentRef.setInput('steps', []);
    fixture.componentRef.setInput('idleText', 'Nothing yet.');
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Nothing yet.');
  });
});
