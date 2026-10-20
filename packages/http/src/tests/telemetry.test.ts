/** Default HTTP spans must observe work without owning or repeating it. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, ContextManager } from '@opentelemetry/api';
import { context, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ResponseCache } from '../idempotency.js';
import { routes } from '../bundle.js';
import { route } from '../contract.js';
import { buildEngine, composeMiddleware } from '../engine.js';
import { HTTP_ERROR_CODES } from '../error.js';
import { IDEMPOTENCY_FAILURES, idempotent } from '../idempotency.js';
import { observeHttp } from '../telemetry.js';

class TestContextManager implements ContextManager {
  readonly storage = new AsyncLocalStorage<Context>();
  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    current: Context,
    callback: F,
    receiver?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(current, () => callback.apply(receiver, args));
  }
  bind<T>(_current: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.storage.disable();
    return this;
  }
}

let provider: BasicTracerProvider | undefined;
function installTelemetry() {
  const exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new TestContextManager());
  return exporter;
}

afterEach(async () => {
  vi.restoreAllMocks();
  context.disable();
  trace.disable();
  await provider?.shutdown();
  provider = undefined;
});

function successEngine(handler = () => ({ ok: true })) {
  return buildEngine([
    routes().bind(
      route.get('/secret', {
        id: 'telemetry.secret',
        output: z.object({ ok: z.boolean() }),
      }),
      handler,
    ),
  ]);
}

const request = () =>
  new Request('https://private.example/secret?token=private-query', {
    headers: { authorization: 'Bearer private-token', cookie: 'session=private-cookie' },
  });

describe('default HTTP telemetry', () => {
  it('serves requests without an installed SDK', async () => {
    trace.disable();
    context.disable();
    const response = await successEngine().fetch(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('exports one request span with its parent and only safe attributes', async () => {
    const exporter = installTelemetry();
    const tracer = trace.getTracer('test');
    const parent = tracer.startSpan('parent');
    let handlerSpanId: string | undefined;
    const engine = successEngine(() => {
      handlerSpanId = trace.getActiveSpan()?.spanContext().spanId;
      return { ok: true };
    });
    await context.with(trace.setSpan(context.active(), parent), () => engine.fetch(request()));
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span?.name).toBe('http.request');
    expect(span?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(span?.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(handlerSpanId).toBe(span?.spanContext().spanId);
    expect(span?.attributes).toEqual({ 'http.response.status_code': 200 });
    expect(span?.events).toEqual([]);
    expect(trace.getActiveSpan()).toBeUndefined();
    parent.end();
  });

  it('records canonical validation failure codes without private input', async () => {
    const exporter = installTelemetry();
    const endpoint = route.get('/validate', {
      id: 'telemetry.validate',
      query: { amount: z.number() },
      output: z.boolean(),
    });
    const response = await buildEngine([routes().bind(endpoint, () => true)]).fetch(
      new Request('https://private.example/validate?amount=private-value'),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'schema.invalid_input' } });
    expect(exporter.getFinishedSpans()[0]?.attributes).toEqual({
      'http.response.status_code': 400,
      'failure.code': 'schema.invalid_input',
    });
  });

  it('marks unexpected defects as errors without exporting their messages', async () => {
    const exporter = installTelemetry();
    const response = await successEngine(() => {
      throw new Error('private database password');
    }).fetch(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: HTTP_ERROR_CODES.internal } });
    expect(exporter.getFinishedSpans()[0]?.attributes).toEqual({
      'http.response.status_code': 500,
      'failure.code': HTTP_ERROR_CODES.internal,
    });
    expect(exporter.getFinishedSpans()[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(exporter.getFinishedSpans()[0]?.events).toEqual([]);
  });

  it('exports protected idempotency work as a child of the request', async () => {
    const exporter = installTelemetry();
    const cache: ResponseCache = {
      begin: () => Promise.resolve('started'),
      finish: () => Promise.resolve(),
      abandon: () => Promise.resolve(),
    };
    const endpoint = route.post('/write', { id: 'telemetry.write', failures: IDEMPOTENCY_FAILURES });
    const protectedFetch = composeMiddleware(
      () => Promise.resolve(Response.json({ ok: true })),
      [
        idempotent({
          cache,
          scope: () => 'private-principal',
          ttl: 60_000,
          routes: [endpoint],
        }),
      ],
    );
    await observeHttp('http.request', () =>
      protectedFetch(
        new Request('https://private.example/write', {
          method: 'POST',
          headers: { 'idempotency-key': 'private-key' },
          body: 'private-body',
        }),
      ),
    );
    const spans = exporter.getFinishedSpans();
    expect(spans.map(span => span.name)).toEqual(['http.idempotency', 'http.request']);
    expect(spans[0]?.parentSpanContext?.spanId).toBe(spans[1]?.spanContext().spanId);
    for (const span of spans) expect(span.attributes).toEqual({ 'http.response.status_code': 200 });
  });

  it('executes once when a defective context callback reenters and then throws', async () => {
    installTelemetry();
    let calls = 0;
    let reenter: (() => void) | undefined;
    vi.spyOn(context, 'with').mockImplementation((_current, callback) => {
      reenter = () => {
        callback();
      };
      callback();
      callback();
      throw new Error('broken context manager');
    });
    const response = await observeHttp('http.request', () => {
      calls += 1;
      if (calls === 1) reenter?.();
      return new Response('ok');
    });
    expect(await response.text()).toBe('ok');
    expect(calls).toBe(1);
  });

  it('falls back once when context entry throws before calling the handler', async () => {
    installTelemetry();
    vi.spyOn(context, 'with').mockImplementation(() => {
      throw new Error('context unavailable');
    });
    const handler = vi.fn(() => new Response('ok'));
    const response = await observeHttp('http.request', handler);
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('preserves the original handler rejection despite repeated context callbacks', async () => {
    const exporter = installTelemetry();
    vi.spyOn(context, 'with').mockImplementation((_current, callback) => {
      callback();
      return callback();
    });
    const failure = new Error('private handler defect');
    const handler = vi.fn(() => {
      throw failure;
    });
    await expect(observeHttp('http.request', handler)).rejects.toBe(failure);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(exporter.getFinishedSpans()[0]?.attributes).toEqual({ 'failure.code': 'failure.unexpected_defect' });
    expect(exporter.getFinishedSpans()[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('executes once when span creation fails', async () => {
    installTelemetry();
    vi.spyOn(trace, 'getTracer').mockImplementation(() => {
      throw new Error('broken provider');
    });
    const handler = vi.fn(() => new Response('ok'));
    const response = await observeHttp('http.request', handler);
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('preserves the response and executes once when finishing a span throws', async () => {
    installTelemetry();
    const tracer = trace.getTracer('@arki/http');
    const startSpan = tracer.startSpan.bind(tracer);
    vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
      const span = startSpan(...args);
      vi.spyOn(span, 'setAttribute').mockImplementation(() => {
        throw new Error('broken attribute');
      });
      vi.spyOn(span, 'setStatus').mockImplementation(() => {
        throw new Error('broken status');
      });
      vi.spyOn(span, 'end').mockImplementation(() => {
        throw new Error('broken exporter');
      });
      return span;
    });
    vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
    const expected = new Response('retry', { status: 503 });
    const handler = vi.fn(() => expected);
    expect(await observeHttp('http.request', handler)).toBe(expected);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
