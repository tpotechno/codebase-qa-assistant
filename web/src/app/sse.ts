export interface SseEvent {
  event: string;
  data: any;
}

/**
 * Incremental Server-Sent Events parser. EventSource only supports GET, and these
 * endpoints are POSTs, so responses are read with fetch and fed through this.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    // Normalize the whole buffer: a \r\n pair can be split across two chunks.
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, '\n');
    const events: SseEvent[] = [];
    let end: number;
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
    }
    return events;
  }
}
