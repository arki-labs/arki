/**
 * KV telemetry against a real Redis (testcontainers; needs Docker). The HTTP response cache is a
 * Redis round trip per request, so each call is a span an operator can see; a returned failure
 * must show its `failure.code`, and the key, owner and response must never leave the process.
 * Under Dot, the probe's commands must sit in the trace of the unit that opened the client.
 *
 * `@arki/testing/otel` depends on `@arki/kv`, so this test builds its provider inline.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, ContextManager } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { context, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { RedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';
import { IdempotencyClaimUnconfirmed, idempotencyOwnerId } from '@arki/http/idempotency';

import { kv } from './dot.js';
import { redisResponseCache } from './redis/idempotency.js';

const storage = new AsyncLocalStorage<Context>();
const manager: ContextManager = {
  active: () => storage.getStore() ?? ROOT_CONTEXT,
  with: (next, fn, thisArg, ...args) => storage.run(next, () => fn.apply(thisArg, args)),
  bind: (_next, target) => target,
  enable: () => manager,
  disable: () => manager,
};
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

let container: StartedRedisContainer;
let redis: Redis;
const owner = idempotencyOwnerId.schema.parse('owner_alice');
const response = { status: 201, headers: { 'content-type': 'application/json' }, body: btoa('{"card":"4242"}') };

beforeAll(async () => {
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(manager);
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
}, 120_000);

afterEach(() => exporter.reset());

afterAll(async () => {
  redis.disconnect();
  await container.stop();
  await provider.shutdown();
  trace.disable();
  context.disable();
});

const named = (name: string): ReadableSpan[] => exporter.getFinishedSpans().filter(span => span.name === name);
const parentOf = (span: ReadableSpan | undefined): ReadableSpan | undefined =>
  exporter.getFinishedSpans().find(other => other.spanContext().spanId === span?.parentSpanContext?.spanId);

/** The nearest `dot.unit.*` span above `span`. */
const unitOf = (span: ReadableSpan | undefined): ReadableSpan | undefined => {
  for (let parent = parentOf(span); parent !== undefined; parent = parentOf(parent)) {
    if (parent.name.startsWith('dot.unit.')) return parent;
  }
  return undefined;
};

describe('redisResponseCache telemetry', () => {
  it('spans begin, finish and abandon, and records no key, owner, fingerprint or response', async () => {
    const cache = redisResponseCache(redis);
    const key = `orders:alice:${Math.random().toString(36).slice(2)}`;
    expect(await cache.begin(key, 'fp_alice', owner)).toBe('started');
    expect(await cache.finish(key, owner, response, 1000)).toBeUndefined();
    expect(await cache.abandon(key, owner)).toBeUndefined();

    const spans = ['kv.idempotency.begin', 'kv.idempotency.finish', 'kv.idempotency.abandon'].map(name => named(name));
    for (const [span] of spans) {
      expect(span?.status.code).toBe(SpanStatusCode.UNSET);
      expect(span?.attributes).toEqual({});
    }
    const recorded = JSON.stringify(exporter.getFinishedSpans().map(span => [span.attributes, span.events]));
    for (const secret of [key, 'owner_alice', 'fp_alice', '4242', response.body])
      expect(recorded).not.toContain(secret);
  });

  it('a returned failure marks the span failed and sets failure.code', async () => {
    const cache = redisResponseCache(redis);
    // A fingerprint with a newline cannot be stored: begin refuses before touching Redis.
    expect(await cache.begin('k', 'bad\nfp', owner)).toMatchObject({ code: IdempotencyClaimUnconfirmed.code });
    const [span] = named('kv.idempotency.begin');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes['failure.code']).toBe(IdempotencyClaimUnconfirmed.code);
  });
});

describe('@arki/kv/dot telemetry', () => {
  it('the probe commands nest under the Dot unit span that opened the client', async () => {
    // Dot runs a unit's factories inside an `async.scope` under its `dot.unit.*` span: walk up to it.
    const app = await orThrow(
      defineApp('kv-otel')
        .infra(kv({ url: container.getConnectionUrl(), probe: true }))
        .boot(),
    );
    await orThrow(app.dispose());

    const [set] = named('kv.set');
    expect(set?.status.code).toBe(SpanStatusCode.UNSET);
    const unit = unitOf(set);
    expect(unit?.attributes['dot.unit.name']).toBe('kv');
    for (const name of ['kv.get', 'kv.delete']) expect(unitOf(named(name)[0])).toBe(unit);
  });
});
