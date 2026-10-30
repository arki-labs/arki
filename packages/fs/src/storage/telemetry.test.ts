import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context, ContextManager } from '@opentelemetry/api';
import { context, metrics, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, expect, it, vi } from 'vitest';

import { orThrow } from '@arki/failure';

import { StorageRejected } from './failures.js';
import { createLocalStorageAdapter } from './local-adapter.js';
import { observeFs } from './operation.js';

class TestContext implements ContextManager {
  readonly storage = new AsyncLocalStorage<Context>();
  active() {
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
  enable() {
    return this;
  }
  disable() {
    this.storage.disable();
    return this;
  }
}

let provider: BasicTracerProvider | undefined;
const directories: string[] = [];
function install() {
  const exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new TestContext());
  return exporter;
}
afterEach(async () => {
  vi.restoreAllMocks();
  context.disable();
  trace.disable();
  await provider?.shutdown();
  provider = undefined;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it('emits a meaningful standalone span and retains an application parent without private attributes', async () => {
  const exporter = install();
  const directory = await mkdtemp(path.join(tmpdir(), 'private-arki-fs-'));
  directories.push(directory);
  const storage = createLocalStorageAdapter({
    provider: 'local',
    basePath: directory,
    baseUrl: 'https://secret.audit.invalid',
  });
  const parent = trace.getTracer('application').startSpan('application.operation');
  const result = await context.with(trace.setSpan(context.active(), parent), () =>
    storage.put('private-key', Buffer.from('private-bytes')),
  );
  orThrow(result);
  parent.end();
  const span = exporter.getFinishedSpans().find(span => span.name === 'fs.local.put');
  expect(span?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  const encoded = JSON.stringify(
    exporter.getFinishedSpans().map(span => ({ name: span.name, attributes: span.attributes, events: span.events })),
  );
  expect(encoded).not.toMatch(/private-|secret\.audit/);
});

it('reports default bounded metrics and failure.code without exporting a cause', async () => {
  const exporter = install();
  const meter = metrics.getMeter('@arki/fs');
  const counter = meter.createCounter('owned');
  const duration = meter.createHistogram('owned');
  const add = vi.spyOn(counter, 'add');
  const record = vi.spyOn(duration, 'record');
  vi.spyOn(metrics, 'getMeter').mockReturnValue(meter);
  vi.spyOn(meter, 'createCounter').mockReturnValue(counter);
  vi.spyOn(meter, 'createHistogram').mockReturnValue(duration);
  const failure = StorageRejected({ cause: new Error('private cause') });
  expect(await observeFs('fs.local.get', () => failure)).toBe(failure);
  expect(add).toHaveBeenCalledWith(1, { operation: 'fs.local.get', 'failure.code': failure.code });
  expect(record).toHaveBeenCalledWith(expect.any(Number), { operation: 'fs.local.get', 'failure.code': failure.code });
  expect(exporter.getFinishedSpans()[0]?.attributes).toEqual({ 'failure.code': failure.code });
});

it.each(['omit', 'repeat', 'throw-before', 'throw-after', 'reject'] as const)(
  'executes once and preserves failure identity when a context manager misbehaves: %s',
  async mode => {
    install();
    const failure = StorageRejected();
    let executions = 0;
    vi.spyOn(context, 'with').mockImplementation((_context, callback) => {
      if (mode === 'throw-before') throw new Error('reporter fault');
      if (mode === 'omit') return;
      const result = callback();
      if (mode === 'repeat') callback();
      if (mode === 'throw-after') throw new Error('reporter fault');
      if (mode === 'reject') return Promise.reject(new Error('asynchronous reporter fault'));
      return result;
    });
    expect(
      await observeFs('fs.local.get', () => {
        executions++;
        return failure;
      }),
    ).toBe(failure);
    await Promise.resolve();
    expect(executions).toBe(1);
  },
);

it('isolates throwing metric providers and rejected end reports', async () => {
  install();
  const tracer = trace.getTracer('@arki/fs');
  const start = tracer.startSpan.bind(tracer);
  vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
    const span = start(...args);
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Deliberately defective void reporter.
    vi.spyOn(span, 'end').mockImplementation(() => Promise.reject(new Error('broken reporter')));
    return span;
  });
  vi.spyOn(metrics, 'getMeter').mockImplementation(() => {
    throw new Error('broken meter');
  });
  const failure = StorageRejected();
  expect(await observeFs('fs.local.get', () => failure)).toBe(failure);
  await Promise.resolve();
});
