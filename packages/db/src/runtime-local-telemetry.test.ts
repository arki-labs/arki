/** Telemetry observes local ownership; it cannot duplicate or replace database work. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context, ContextManager } from '@opentelemetry/api';
import { PGlite } from '@electric-sql/pglite';
import { context, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';
import { orThrow, UnexpectedDefect } from '@arki/failure';

import { ownerId } from './owner-lock.js';
import { observeLocalRuntime } from './runtime-local-telemetry.js';
import { DataDirInUse, initDbRuntimeLocal, LocalRuntimeCleanupFailed } from './runtime-local.js';

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
const directories: string[] = [];
const closes: (() => Promise<unknown>)[] = [];
function installTelemetry() {
  const exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new TestContextManager());
  return exporter;
}
async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), 'arki-private-db-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closes.splice(0)) await close();
  context.disable();
  trace.disable();
  await provider?.shutdown();
  provider = undefined;
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('local runtime telemetry ownership', () => {
  it('works without an SDK and keeps the returned close detached-call safe', async () => {
    const opened = await orThrow(initDbRuntimeLocal({ memory: true }, { relations: {} }));
    closes.push(opened.close);
    const close = opened.close;
    expect(await close()).toBeUndefined();
  });

  it('parents acquisition to init, parents close to its current caller, and exports no private data', async () => {
    const exporter = installTelemetry();
    const tracer = trace.getTracer('test');
    const startup = tracer.startSpan('startup');
    const dataDir = await directory();
    const opened = await context.with(trace.setSpan(context.active(), startup), () =>
      orThrow(initDbRuntimeLocal({ dataDir }, { relations: {} })),
    );
    closes.push(opened.close);
    const shutdown = tracer.startSpan('shutdown');
    await orThrow(context.with(trace.setSpan(context.active(), shutdown), opened.close));
    const spans = exporter.getFinishedSpans();
    const init = spans.find(span => span.name === 'db.local.init');
    const acquire = spans.find(span => span.name === 'db.local.acquire');
    const close = spans.find(span => span.name === 'db.local.close');
    expect(spans).toHaveLength(3);
    expect(init?.parentSpanContext?.spanId).toBe(startup.spanContext().spanId);
    expect(acquire?.parentSpanContext?.spanId).toBe(init?.spanContext().spanId);
    expect(close?.parentSpanContext?.spanId).toBe(shutdown.spanContext().spanId);
    for (const span of spans) {
      expect(span.attributes).toEqual({});
      expect(span.events).toEqual([]);
    }
    expect(trace.getActiveSpan()).toBeUndefined();
  });

  it('skips acquisition for memory and preserves entropy failures without creating a database', async () => {
    const exporter = installTelemetry();
    const opened = await orThrow(initDbRuntimeLocal({ memory: true }, { relations: {} }));
    closes.push(opened.close);
    expect(exporter.getFinishedSpans().map(span => span.name)).toEqual(['db.local.init']);
    const failure = RandomSourceUnavailable();
    vi.spyOn(ownerId, 'create').mockReturnValue(failure);
    expect(await initDbRuntimeLocal({ dataDir: await directory() }, { relations: {} })).toBe(failure);
    const failed = exporter.getFinishedSpans().filter(span => span.attributes['failure.code'] === failure.code);
    expect(failed.map(span => span.name)).toEqual(['db.local.acquire', 'db.local.init']);
    for (const span of failed) expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('retains ownership on failed close, permits retry, and does not duplicate concurrent driver closes', async () => {
    const exporter = installTelemetry();
    const dir = await directory();
    const opened = await orThrow(initDbRuntimeLocal({ dataDir: dir }, { relations: {} }));
    closes.push(opened.close);
    const closeDriver = vi.spyOn(PGlite.prototype, 'close').mockRejectedValueOnce(new Error('private close defect'));
    const [first, concurrent] = await Promise.all([opened.close(), opened.close()]);
    expect(LocalRuntimeCleanupFailed.is(first)).toBe(true);
    expect(concurrent).toBe(first);
    expect(closeDriver).toHaveBeenCalledTimes(1);
    expect(DataDirInUse.is(await initDbRuntimeLocal({ dataDir: dir }, { relations: {} }))).toBe(true);
    await orThrow(opened.close());
    expect(closeDriver).toHaveBeenCalledTimes(2);
    const spans = exporter.getFinishedSpans().filter(span => span.name === 'db.local.close');
    expect(spans).toHaveLength(2);
    expect(spans[0]?.attributes).toEqual({ 'failure.code': LocalRuntimeCleanupFailed.code });
    expect(spans[1]?.attributes).toEqual({});
  });

  it('shares the reserved close when span creation and completion reenter the owned boundary', async () => {
    installTelemetry();
    const opened = await orThrow(initDbRuntimeLocal({ memory: true }, { relations: {} }));
    closes.push(opened.close);
    const tracer = trace.getTracer('@arki/db');
    const start = tracer.startSpan.bind(tracer);
    const reentries: Promise<unknown>[] = [];
    vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
      reentries.push(opened.close());
      const span = start(...args);
      const end = span.end.bind(span);
      vi.spyOn(span, 'end').mockImplementation((...endArgs) => {
        reentries.push(opened.close());
        end(...endArgs);
      });
      return span;
    });
    const closeDriver = vi.spyOn(PGlite.prototype, 'close');
    await orThrow(opened.close());
    await Promise.all(reentries);
    expect(closeDriver).toHaveBeenCalledTimes(1);
    expect(reentries).toHaveLength(2);
  });
});

describe('local runtime observer isolation', () => {
  it.each(['omit', 'repeat', 'throw-before', 'throw-after', 'reject'] as const)(
    'executes once and preserves failure identity when context managers %s',
    async mode => {
      const exporter = installTelemetry();
      vi.spyOn(context, 'with').mockImplementation((_current, callback) => {
        if (mode === 'throw-before') throw new Error('broken context');
        if (mode === 'omit') return;
        const result = callback();
        if (mode === 'repeat') callback();
        if (mode === 'throw-after') throw new Error('broken context');
        if (mode === 'reject') return Promise.reject(new Error('broken asynchronous context'));
        return result;
      });
      const failure = RandomSourceUnavailable();
      const run = vi.fn(() => failure);
      expect(await observeLocalRuntime('db.local.init', run)).toBe(failure);
      expect(run).toHaveBeenCalledTimes(1);
      // Exporters also use context.with; a broken manager may suppress export itself.
      if (mode !== 'omit' && mode !== 'throw-before')
        expect(exporter.getFinishedSpans()[0]?.attributes).toEqual({ 'failure.code': failure.code });
    },
  );

  it('keeps the exact thrown defect and never exports its message', async () => {
    const exporter = installTelemetry();
    const error = new Error('private directory and extension details');
    await expect(
      observeLocalRuntime('db.local.init', () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes).toEqual({ 'failure.code': UnexpectedDefect.code });
    expect(span?.events).toEqual([]);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('executes once even when obtaining a tracer throws', async () => {
    vi.spyOn(trace, 'getTracer').mockImplementation(() => {
      throw new Error('broken provider');
    });
    const result = {};
    const run = vi.fn(() => result);
    expect(await observeLocalRuntime('db.local.init', run)).toBe(result);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('preserves success when span creation throws', async () => {
    installTelemetry();
    const tracer = trace.getTracer('@arki/db');
    vi.spyOn(tracer, 'startSpan').mockImplementation(() => {
      throw new Error('broken tracer');
    });
    const run = vi.fn(() => 'success');
    expect(await observeLocalRuntime('db.local.init', run)).toBe('success');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('observes rejected asynchronous end reports without changing success', async () => {
    installTelemetry();
    const tracer = trace.getTracer('@arki/db');
    const start = tracer.startSpan.bind(tracer);
    vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
      const span = start(...args);
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Deliberately defective reporter returns a rejected promise despite its void API.
      vi.spyOn(span, 'end').mockImplementation(() => Promise.reject(new Error('broken async exporter')));
      return span;
    });
    const result = {};
    expect(await observeLocalRuntime('db.local.init', () => result)).toBe(result);
    await Promise.resolve();
  });

  it('preserves a returned failure when every finishing reporter throws', async () => {
    installTelemetry();
    const tracer = trace.getTracer('@arki/db');
    const start = tracer.startSpan.bind(tracer);
    vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
      const span = start(...args);
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
    const failure = RandomSourceUnavailable();
    const run = vi.fn(() => failure);
    expect(await observeLocalRuntime('db.local.init', run)).toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
