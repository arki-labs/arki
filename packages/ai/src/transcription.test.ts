import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, expect, expectTypeOf, test, vi } from 'vitest';

import type { z } from '@arki/contracts';
import { isFailure, orThrow } from '@arki/failure';

import type { DiarizedTranscript, TranscriptionFailure } from './transcription';
import { transcribeDiarizedAudio } from './transcription';
import type { diarizedTranscriptSchema, transcriptionOptionsSchema } from './transcription-schemas';

const originalFetch = globalThis.fetch;
const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  exporter.reset();
});
afterAll(() => {
  trace.disable();
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
      return Response.json(raw());
    }),
    {},
  );
  const result = orThrow(await transcribeDiarizedAudio(new Uint8Array([1]), options, controller.signal));
  expect(result.segments[0]?.speaker).toBe('speaker-2');
});

for (const end of [0, 11])
  test(`rejects invalid diarization end ${end}`, async () => {
    globalThis.fetch = Object.assign(
      vi.fn(async () => Response.json(raw(end))),
      {},
    );
    const result = await transcribeDiarizedAudio(new Uint8Array([1]), options);
    expect(isFailure(result) && result.code).toBe('ai.invalid_output');
  });

test('rejects oversized response before parsing', async () => {
  globalThis.fetch = Object.assign(
    vi.fn(async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1))),
    {},
  );
  const result = await transcribeDiarizedAudio(new Uint8Array([1]), options);
  expect(isFailure(result) && result.code).toBe('ai.invalid_output');
});

// A caller must tell "wait and retry" from "fix the key" from "Deepgram is down": each refusal is its own
// returned failure, never a raw Error or ZodError.
const respond = (response: () => Response | Promise<Response>) => {
  globalThis.fetch = Object.assign(vi.fn(async () => response()), {});
};
const codeOf = async (bytes = new Uint8Array([1]), input = options, signal?: AbortSignal) => {
  const result = await transcribeDiarizedAudio(bytes, input, signal);
  return isFailure(result) ? result : undefined;
};

test('a 429 is RateLimited and keeps the Retry-After wait', async () => {
  respond(() => new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }));
  const failure = await codeOf();
  expect(failure?.code).toBe('ai.rate_limited');
  expect(failure?.code === 'ai.rate_limited' && failure.data.retryAfterMs).toBe(2000);
});

test('401 and 403 are ProviderUnauthorized; other statuses are ProviderFailed', async () => {
  for (const status of [401, 403]) {
    respond(() => new Response('{}', { status }));
    expect(await codeOf()).toHaveProperty('code', 'ai.unauthorized');
  }
  respond(() => new Response('{}', { status: 503 }));
  const failure = await codeOf();
  expect(failure?.code).toBe('ai.provider_failed');
  expect(failure?.code === 'ai.provider_failed' && failure.data.status).toBe(503);
});

test('a body that is not JSON is InvalidOutput', async () => {
  respond(() => new Response('not json'));
  expect(await codeOf()).toHaveProperty('code', 'ai.invalid_output');
});

test('a network failure is ProviderFailed; the caller abort is Cancelled', async () => {
  respond(() => Promise.reject(new TypeError('fetch failed')));
  expect(await codeOf()).toHaveProperty('code', 'ai.provider_failed');
  const controller = new AbortController();
  controller.abort();
  respond(() => Promise.reject(new DOMException('aborted', 'AbortError')));
  expect(await codeOf(new Uint8Array([1]), options, controller.signal)).toHaveProperty('code', 'ai.cancelled');
});

test('empty audio and a blank key are InvalidInput, before any request', async () => {
  const fetchMock = vi.fn(async () => Response.json(raw()));
  globalThis.fetch = Object.assign(fetchMock, {});
  expect(await codeOf(new Uint8Array())).toHaveProperty('code', 'schema.invalid_input');
  expect(await codeOf(new Uint8Array([1]), { deepgramKey: ' ' })).toHaveProperty('code', 'schema.invalid_input');
  expect(fetchMock).not.toHaveBeenCalled();
});

// `./transcription` exposes plain TS types (the source); the schemas that parse the same data are internal.
// These exact two-way tests keep them equal, so the published types never drift from what is parsed.
test('the options and the transcript are exactly what the schemas take and return', () => {
  expectTypeOf<Parameters<typeof transcribeDiarizedAudio>[1]>().toEqualTypeOf<
    z.input<typeof transcriptionOptionsSchema>
  >();
  expectTypeOf<DiarizedTranscript>().toEqualTypeOf<z.output<typeof diarizedTranscriptSchema>>();
  expectTypeOf<Exclude<Awaited<ReturnType<typeof transcribeDiarizedAudio>>, TranscriptionFailure>>().toEqualTypeOf<DiarizedTranscript>();
});

test('records an ai.transcribe span for a transcription', async () => {
  globalThis.fetch = Object.assign(
    vi.fn(async () => Response.json(raw())),
    {},
  );
  orThrow(await transcribeDiarizedAudio(new Uint8Array([1]), options));

  const [span] = exporter.getFinishedSpans();
  expect(span?.name).toBe('ai.transcribe');
  expect(span?.instrumentationScope.name).toBe('@arki/ai');
  expect(span?.attributes['ai.provider']).toBe('deepgram');
  expect(span?.status.code).not.toBe(2);
});

test('marks the ai.transcribe span failed with the code of the returned failure', async () => {
  // WHY: a refused call is returned, not thrown; the span must still show it as failed.
  respond(() => new Response('{}', { status: 429 }));
  expect(isFailure(await transcribeDiarizedAudio(new Uint8Array([1]), options))).toBe(true);

  const [span] = exporter.getFinishedSpans();
  expect(span?.status.code).toBe(2);
  expect(span?.attributes['failure.code']).toBe('ai.rate_limited');
});
