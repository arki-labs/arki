/** Every KV command runs in a `kv.<command>` span, ended even when the command fails. */
import type { Span, Tracer, TracerProvider } from '@opentelemetry/api';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { defineFailure, isFailure } from '@arki/failure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { observeKv } from './telemetry.js';

type Started = { name: string; ended: boolean; errored: boolean; status?: SpanStatusCode; failureCode?: unknown };
const started: Started[] = [];
const tracer: Tracer = {
  startSpan(name) {
    const record: Started = { name, ended: false, errored: false };
    started.push(record);
    return {
      recordException: () => {
        record.errored = true;
      },
      setAttribute: (key: string, value: unknown) => {
        if (key === 'failure.code') record.failureCode = value;
      },
      setStatus: (status: { code: SpanStatusCode }) => {
        record.status = status.code;
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
  it('marks the span failed when the command returns a fault (5xx)', async () => {
    const Down = defineFailure('test.down', { status: 503 });
    expect(isFailure(await observeKv('get', () => Promise.resolve(Down())))).toBe(true);
    expect(started.at(-1)).toMatchObject({ name: 'kv.get', ended: true, status: SpanStatusCode.ERROR, failureCode: 'test.down' });
  });

  // An expected outcome is an answer the caller handles, not a fault: it must not trip alerts on span errors.
  it('sets failure.code but leaves the status unset when the command returns an expected outcome (4xx)', async () => {
    const Taken = defineFailure('test.taken', { status: 409 });
    expect(isFailure(await observeKv('set', () => Promise.resolve(Taken())))).toBe(true);
    expect(started.at(-1)).toMatchObject({ name: 'kv.set', ended: true, failureCode: 'test.taken' });
    expect(started.at(-1)?.status).toBeUndefined();
  });

  it('opens a kv.<command> span and ends it on success', async () => {
    expect(await observeKv('get', () => Promise.resolve(42))).toBe(42);
    expect(started.at(-1)).toEqual({ name: 'kv.get', ended: true, errored: false });
  });

  it('records the error, ends the span and rethrows when the command fails', async () => {
    await expect(observeKv('set', () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(started.at(-1)).toEqual({ name: 'kv.set', ended: true, errored: true, status: SpanStatusCode.ERROR });
  });
});
