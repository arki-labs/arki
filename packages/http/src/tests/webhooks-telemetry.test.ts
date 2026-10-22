/** Reporting cannot authenticate, repeat or change webhook operations. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, ContextManager } from '@opentelemetry/api';
import { context, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { orThrow, UnexpectedDefect } from '@arki/failure';

import { observeWebhook } from '../webhook-telemetry.js';
import { standardWebhooks, verifyWebhook, WebhookSignatureMismatch } from '../webhooks.js';

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

const body = new TextEncoder().encode('private payload');
const scheme = () => standardWebhooks({ secrets: ['cHJpdmF0ZS1zZWNyZXQ='] });

describe('webhook telemetry', () => {
  it('inherits current caller context and nests verification beneath request preparation', async () => {
    const exporter = installTelemetry();
    const parent = trace.getTracer('test').startSpan('parent');
    const subject = scheme();
    const headers = orThrow(
      await context.with(trace.setSpan(context.active(), parent), () => subject.sign(body, { id: 'private-id' })),
    );
    await context.with(trace.setSpan(context.active(), parent), () =>
      verifyWebhook({ scheme: subject })({ req: new Request('https://test/hook', { method: 'POST', body, headers }) }),
    );
    const spans = exporter.getFinishedSpans();
    expect(spans.map(span => span.name).toSorted()).toEqual([
      'http.webhook.request',
      'http.webhook.sign',
      'http.webhook.verify',
    ]);
    const sign = spans.find(span => span.name === 'http.webhook.sign');
    const request = spans.find(span => span.name === 'http.webhook.request');
    const verify = spans.find(span => span.name === 'http.webhook.verify');
    expect(sign?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(request?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(verify?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
    for (const span of spans) {
      expect(span.attributes).toEqual({});
      expect(span.events).toEqual([]);
    }
    parent.end();
  });

  it('records only the exact refusal code and preserves its identity', async () => {
    const exporter = installTelemetry();
    const refusal = WebhookSignatureMismatch({ cause: new Error('private cause') });
    expect(await observeWebhook('http.webhook.verify', () => refusal)).toBe(refusal);
    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes).toEqual({ 'failure.code': refusal.code });
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(span?.events).toEqual([]);
  });

  it.each(['omit', 'repeat', 'throw-before', 'throw-after', 'reject'])(
    'executes once when context %s',
    async behavior => {
      installTelemetry();
      vi.spyOn(context, 'with').mockImplementation((_current, callback) => {
        if (behavior === 'throw-before') throw new Error('broken context');
        if (behavior === 'omit') return;
        const value = callback();
        if (behavior === 'repeat') callback();
        if (behavior === 'throw-after') throw new Error('broken context');
        if (behavior === 'reject') return Promise.reject(new Error('broken context'));
        return value;
      });
      const refusal = WebhookSignatureMismatch();
      const run = vi.fn(() => refusal);
      expect(await observeWebhook('http.webhook.verify', run)).toBe(refusal);
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it.each(['start', 'attribute', 'status', 'end', 'reject-end'])('survives %s reporter defects', async stage => {
    installTelemetry();
    const tracer = trace.getTracer('@arki/http');
    const start = tracer.startSpan.bind(tracer);
    vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
      if (stage === 'start') throw new Error('broken reporter');
      const span = start(...args);
      const fail = () => {
        throw new Error('broken reporter');
      };
      if (stage === 'attribute') vi.spyOn(span, 'setAttribute').mockImplementation(fail);
      if (stage === 'status') vi.spyOn(span, 'setStatus').mockImplementation(fail);
      if (stage === 'end') vi.spyOn(span, 'end').mockImplementation(fail);
      if (stage === 'reject-end')
        Object.defineProperty(span, 'end', { value: () => Promise.reject(new Error('broken reporter')) });
      return span;
    });
    const refusal = WebhookSignatureMismatch();
    const run = vi.fn(() => refusal);
    expect(await observeWebhook('http.webhook.verify', run)).toBe(refusal);
    expect(run).toHaveBeenCalledOnce();
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('turns an owned callback rejection into a private canonical defect', async () => {
    const exporter = installTelemetry();
    const cause = new Error('private callback');
    const result = await observeWebhook('http.webhook.verify', () => Promise.reject(cause));
    expect(result).toMatchObject({ code: UnexpectedDefect.code, cause });
    expect(exporter.getFinishedSpans()[0]?.attributes).toEqual({ 'failure.code': UnexpectedDefect.code });
  });
});
