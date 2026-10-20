import { AsyncLocalStorage } from 'node:async_hooks';
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { Context, ContextManager, Span } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { QueueStorageUnavailable } from '../../src/mutations/failures.ts';
import { observeEnqueue } from '../../src/mutations/telemetry.ts';

const contexts = new AsyncLocalStorage<Context>();
const manager: ContextManager = {
  active: () => contexts.getStore() ?? ROOT_CONTEXT,
  with: (next, fn, thisArg, ...args) => contexts.run(next, () => fn.apply(thisArg, args)),
  bind: (_next, target) => target,
  enable: () => manager,
  disable: () => manager,
};
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(manager);
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

it('inherits the application context and reports only the canonical failure code', async () => {
  const parent = trace.getTracer('app').startSpan('request');
  const failure = QueueStorageUnavailable({ cause: new Error('private input and storage details') });
  let active: string | undefined;
  const result = await context.with(trace.setSpan(context.active(), parent), () => observeEnqueue(() => {
    active = trace.getActiveSpan()?.spanContext().spanId;
    return Promise.resolve(failure);
  }));
  parent.end();
  expect(result).toBe(failure);
  const span = exporter.getFinishedSpans().find(entry => entry.name === 'offline.queue.enqueue');
  expect(span?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  expect(span?.spanContext().spanId).toBe(active);
  expect(span?.attributes).toEqual({ 'failure.code': failure.code });
  expect(span?.events).toEqual([]);
});

it('observes rejected asynchronous span reporters without repeating owned work', async () => {
  const base = trace.getTracer('test.reporter').startSpan('base');
  class RejectedSpan extends Promise<void> implements Span {
    spanContext() { return base.spanContext(); }
    isRecording() { return false; }
    setAttribute() { return this; }
    setAttributes() { return this; }
    addEvent() { return this; }
    addLink() { return this; }
    addLinks() { return this; }
    setStatus() { return this; }
    updateName() { return this; }
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Exercise a malformed JS reporter returning a rejected promise from a void API.
    end() { return this; }
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- The foreign Span API is intentionally malformed in this reporter regression.
    recordException() { return this; }
  }
  const rejected = new RejectedSpan((_resolve, reject) => reject(new Error('private reporter refusal')));
  const tracer = trace.getTracer('test.reporter');
  const start = vi.spyOn(tracer, 'startSpan').mockReturnValue(rejected);
  const getTracer = vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
  let calls = 0;
  const failure = QueueStorageUnavailable();
  try {
    expect(await observeEnqueue(() => { calls++; return Promise.resolve(failure); })).toBe(failure);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  } finally {
    getTracer.mockRestore();
    start.mockRestore();
    base.end();
  }
});


vi.mock('idb-keyval', () => ({
  get: (key: string) => key === 'refused' ? Promise.reject(new Error('private IDB error')) : Promise.resolve(),
  set: () => Promise.resolve(),
  del: () => Promise.resolve(),
}));

it('instruments real storage boundaries with safe attributes and application context', async () => {
  const { createQueueStorage } = await import('../../src/mutations/storage.ts');
  const parent = trace.getTracer('app').startSpan('storage-request');
  const storage = createQueueStorage('private storage identity');
  await context.with(trace.setSpan(context.active(), parent), async () => {
    expect(await storage.write([])).toBeUndefined();
    expect(await storage.read()).toEqual([]);
    expect(QueueStorageUnavailable.is(await createQueueStorage('refused').read())).toBe(true);
  });
  parent.end();
  const spans = exporter.getFinishedSpans().filter(span => span.parentSpanContext?.spanId === parent.spanContext().spanId);
  expect(spans.map(span => span.name)).toEqual(['offline.storage.write', 'offline.storage.read', 'offline.storage.read']);
  expect(spans.map(span => span.attributes)).toEqual([{}, {}, { 'failure.code': QueueStorageUnavailable.code }]);
});
