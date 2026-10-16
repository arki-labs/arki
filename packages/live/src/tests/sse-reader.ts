/**
 * Reads `LiveEvent` frames off an SSE response, the way a client does:
 * `ReadableStream` chunks through a streaming `TextDecoder`, frames split on a
 * blank line, `:keepalive` comments skipped, every `data:` checked against the
 * wire schema. Test-only.
 */
import type { LiveEvent } from '../index.js';
import { parseLiveEvent } from '../index.js';

export type SseReader = {
  /** The next frame, or `undefined` once the stream ended. */
  next(): Promise<LiveEvent | undefined>;
  cancel(): Promise<void>;
};

export function sseReader(response: Response): SseReader {
  if (!response.body) throw new Error(`no body (status ${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function next(): Promise<LiveEvent | undefined> {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith(':')) continue;
        if (block.startsWith('event: error')) throw new Error(`stream error: ${block}`);
        const data = block
          .split('\n')
          .filter(line => line.startsWith('data: '))
          .map(line => line.slice('data: '.length))
          .join('\n');
        const event = parseLiveEvent(JSON.parse(data));
        if (event === undefined) throw new Error(`not a live frame: ${data}`);
        return event;
      }
      const chunk = await reader.read();
      if (chunk.done) return undefined;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  return { next, cancel: () => reader.cancel() };
}
