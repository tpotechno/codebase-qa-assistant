import { describe, expect, it } from 'vitest';
import { SseParser } from './sse';

describe('SseParser', () => {
  it('parses complete frames and keeps partial ones for the next chunk', () => {
    const p = new SseParser();
    expect(p.push('event: text\ndata: {"delta":"Hel')).toEqual([]);
    expect(p.push('lo","turn":1}\n\nevent: done\ndata: {"ok":true}\n\n')).toEqual([
      { event: 'text', data: { delta: 'Hello', turn: 1 } },
      { event: 'done', data: { ok: true } },
    ]);
  });

  it('handles CRLF line endings and frames split across many chunks', () => {
    const p = new SseParser();
    const frame = 'event: tool_call\r\ndata: {"name":"read_file"}\r\n\r\n';
    const events = [...frame].flatMap((ch) => p.push(ch));
    expect(events).toEqual([{ event: 'tool_call', data: { name: 'read_file' } }]);
  });

  it('defaults the event name to message', () => {
    expect(new SseParser().push('data: 1\n\n')).toEqual([{ event: 'message', data: 1 }]);
  });
});
