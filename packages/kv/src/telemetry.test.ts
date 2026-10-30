/** Every KV command runs in a `kv.<command>` span, ended even when the command fails. */
import type { Span, Tracer, TracerProvider } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { observeKv } from './telemetry.js';

const started: { name: string; ended: boolean; errored: boolean }[] = [];
const tracer: Tracer = {
  startSpan(name) {
    const record = { name, ended: false, errored: false };
    started.push(record);
    return {
      recordException: () => {
        record.errored = true;
      },
      setStatus: () => {
        /* the status is not under test */
      },
      end: () => {
        record.ended = true;
      },
    } as unknown as Span;
  },
  startActiveSpan: () => {
    throw new Error('not used');
  },
};
const provider: TracerProvider = { getTracer: () => tracer };

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});
afterAll(() => trace.disable());

describe('observeKv', () => {
  it('opens a kv.<command> span and ends it on success', async () => {
    expect(await observeKv('get', () => Promise.resolve(42))).toBe(42);
    expect(started.at(-1)).toEqual({ name: 'kv.get', ended: true, errored: false });
  });

  it('records the error, ends the span and rethrows when the command fails', async () => {
    await expect(observeKv('set', () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(started.at(-1)).toEqual({ name: 'kv.set', ended: true, errored: true });
  });
});
