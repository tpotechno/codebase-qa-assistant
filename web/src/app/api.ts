import { Injectable } from '@angular/core';
import { AppConfig, PostResult } from './models';
import { SseEvent, SseParser } from './sse';

async function errorFrom(res: Response): Promise<Error> {
  const body = await res.json().catch(() => ({}) as { error?: string });
  return new Error(body.error ?? `The server answered ${res.status}.`);
}

/** Talks to the local API server (npm run web). */
@Injectable({ providedIn: 'root' })
export class Api {
  async config(): Promise<AppConfig> {
    const res = await fetch('/api/config');
    if (!res.ok) throw await errorFrom(res);
    return res.json();
  }

  /** POST JSON and deliver each Server-Sent Event as it arrives. Resolves when the stream ends. */
  async stream(path: string, body: unknown, onEvent: (e: SseEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) throw await errorFrom(res);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    const parser = new SseParser();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of parser.push(value)) onEvent(event);
    }
  }

  /** Post a review the server produced. The server looks the draft up by id and posts it once. */
  async postReview(draftId: string): Promise<PostResult> {
    const res = await fetch('/api/review/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId }),
    });
    if (!res.ok) throw await errorFrom(res);
    return res.json();
  }
}
