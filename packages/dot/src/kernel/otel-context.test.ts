/** A broken app-owned context manager must not skip, replay or replace application work. */
import type { Context, ContextManager } from '@opentelemetry/api';
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { defineFailure } from '@arki/failure';

import { telemetryFor } from '../telemetry.js';
import { traceUsecase, withPhaseSpan, withPluginHookSpan } from './otel.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const Refused = defineFailure('context.refused');
const modes = ['active', 'before', 'after', 'replace-throw', 'twice'] as const;
const boundaries = [
  ['custom', (run: () => unknown) => telemetryFor({ name: 'context' }).span('work', run)],
  ['phase', (run: () => unknown) => withPhaseSpan({ appName: 'context', phase: 'boot', pluginCount: 0 }, run)],
  [
    'hook',
    (run: () => unknown) => withPluginHookSpan({ appName: 'context', pluginName: 'p', hook: 'boot', order: 0 }, run),
  ],
  [
    'usecase',
    (run: () => unknown) => {
      const wrapped = traceUsecase('context', 'work', run);
      if (typeof wrapped !== 'function') throw new Error('missing traced function');
      return wrapped();
    },
  ],
] as const;

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});
afterEach(() => {
  context.disable();
  exporter.reset();
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

function brokenContext(mode: (typeof modes)[number]): ContextManager {
  const reporter = new Error('context reporter failed');
  let current: Context = ROOT_CONTEXT;
  const manager: ContextManager = {
    active: () => {
      if (mode === 'active') throw reporter;
      return current;
    },
    with: (next, fn, receiver, ...args) => {
      if (mode === 'before') throw reporter;
      const previous = current;
      current = next;
      try {
        const value = fn.apply(receiver, args);
        if (mode === 'after') throw reporter;
        if (mode === 'twice') return fn.apply(receiver, args);
        return value;
      } catch (error) {
        if (mode === 'replace-throw') throw reporter;
        throw error;
      } finally {
        current = previous;
      }
    },
    bind: (_next, target) => target,
    enable: () => manager,
    disable: () => manager,
  };
  return manager;
}

for (const [name, runBoundary] of boundaries) {
  describe(name, () => {
    it.each(modes)('preserves one execution and its exact outcome when context %s fails', async mode => {
      context.setGlobalContextManager(brokenContext(mode));
      for (const value of [{ id: 'kept' }, Refused(), undefined, Promise.resolve('kept')]) {
        let calls = 0;
        const returned = runBoundary(() => {
          calls += 1;
          return value;
        });
        expect(returned).toBe(value);
        expect(calls).toBe(1);
        await Promise.resolve(returned);
      }
      for (const cause of [new Error('application failed'), { reason: 'application refused' }, undefined]) {
        let calls = 0;
        let completed = false;
        let caught: unknown;
        try {
          runBoundary(() => {
            calls += 1;
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- JavaScript can throw any value; preserve it exactly.
            throw cause;
          });
          completed = true;
        } catch (error) {
          caught = error;
        }
        expect(completed).toBe(false);
        expect(caught).toBe(cause);
        expect(calls).toBe(1);
      }
      const cause = new Error('application rejected');
      const pending = Promise.reject(cause);
      void pending.catch(() => false);
      let calls = 0;
      const returned = runBoundary(() => {
        calls += 1;
        return pending;
      });
      expect(returned).toBe(pending);
      await expect(returned).rejects.toBe(cause);
      expect(calls).toBe(1);
    });
  });
}

it('preserves custom work when active() throws after a tracer has already supplied a span', () => {
  const realTracer = provider.getTracer('app');
  const span = realTracer.startSpan('custom');
  trace.disable();
  trace.setGlobalTracerProvider({
    getTracer: () => ({
      startSpan: () => span,
      startActiveSpan: realTracer.startActiveSpan.bind(realTracer),
    }),
  });
  context.setGlobalContextManager(brokenContext('active'));
  try {
    let calls = 0;
    const value = { ready: true };
    expect(
      telemetryFor({ name: 'custom' }).span('work', () => {
        calls += 1;
        return value;
      }),
    ).toBe(value);
    expect(calls).toBe(1);
    expect(span.isRecording()).toBe(false);
  } finally {
    trace.disable();
    trace.setGlobalTracerProvider(provider);
  }
});
