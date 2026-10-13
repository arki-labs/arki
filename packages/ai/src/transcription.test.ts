import { afterEach, expect, test, vi } from 'vitest';

import { transcribeDiarizedAudio } from './transcription';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const raw = (end = 10) => ({
  metadata: { duration: 10 },
  results: {
    channels: [{ detected_language: 'en' }],
    utterances: [{ start: 0, end, transcript: 'Hello.', speaker: 2, confidence: 0.9 }],
  },
});
const options = { deepgramKey: 'test' };

test('shared transcription validates speaker IDs, intervals and cancellation wiring', async () => {
  const controller = new AbortController();
  globalThis.fetch = Object.assign(
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return new Response(JSON.stringify(raw()));
    }),
    {},
  );
  const result = await transcribeDiarizedAudio(new Uint8Array([1]), options, controller.signal);
  expect(result.segments[0]?.speaker).toBe('speaker-2');
});

for (const end of [0, 11])
  test(`rejects invalid diarization end ${end}`, async () => {
    globalThis.fetch = Object.assign(
      vi.fn(async () => new Response(JSON.stringify(raw(end)))),
      {},
    );
    await expect(transcribeDiarizedAudio(new Uint8Array([1]), options)).rejects.toThrow();
  });

test('rejects oversized response before parsing', async () => {
  globalThis.fetch = Object.assign(
    vi.fn(async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1))),
    {},
  );
  await expect(transcribeDiarizedAudio(new Uint8Array([1]), options)).rejects.toThrow('byte limit');
});
