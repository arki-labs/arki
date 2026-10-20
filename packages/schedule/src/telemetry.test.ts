import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, ContextManager } from '@opentelemetry/api';
import { context, metrics, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

import { defineSchedule } from './index.js';
import { createScheduleRuntime } from './runtime.js';

const Refused = defineFailure('schedule.telemetry_refused', { status: 409, data: z.object({ secret: z.string() }) });
const storage = new AsyncLocalStorage<Context>();
let failContext = '';
const manager: ContextManager = {
  active: () => storage.getStore() ?? ROOT_CONTEXT,
  with: (next, fn, thisArg, ...args) => {
    if (failContext === 'before') throw new Error('context unavailable');
    const result = storage.run(next, () => fn.apply(thisArg, args));
    if (failContext === 'after') throw new Error('context cleanup failed');
    return result;
  },
  bind: (_next, target) => target,
  enable: () => manager,
  disable: () => manager,
};
let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  failContext = '';
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(manager);
});

afterEach(async () => {
  failContext = '';
  vi.restoreAllMocks();
  await provider.shutdown();
  trace.disable();
  context.disable();
  metrics.disable();
});

describe('schedule observation', () => {
  it('keeps parent context and records classified refusals without collecting private data', async () => {
    const refusal = Refused({ secret: 'never collect this' });
    const parent = trace.getTracer('app').startSpan('request');
    const report = defineSchedule({
      name: 'report',
      every: '1h',
      handler: async () => {
        const span = trace.getActiveSpan();
        await Promise.resolve();
        expect(trace.getActiveSpan()).toBe(span);
        span?.addEvent('report.stage', { stage: 'checked' });
        return refusal;
      },
    });
    const runtime = createScheduleRuntime({ schedules: [report], clock: 'host' });
    const result = await context.with(trace.setSpan(context.active(), parent), () => runtime.trigger('report'));
    parent.end();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const run = spans.find(span => span.name === 'schedule.run');
    expect(run?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(run?.attributes).toEqual({ 'schedule.name': 'report', 'schedule.outcome': 'refused' });
    expect(run?.status.code).toBe(SpanStatusCode.ERROR);
    expect(run?.events.map(event => event.name)).toEqual(['report.stage']);
    expect(JSON.stringify(spans.map(span => ({ attributes: span.attributes, events: span.events })))).not.toContain(
      'never collect this',
    );
    expect(result).toEqual({ name: 'report', status: 'refused', failure: refusal });
    await runtime.stop();
  });

  it.each(['before', 'after'])('never repeats the handler when context fails %s invocation', async mode => {
    let calls = 0;
    const report = defineSchedule({
      name: 'report',
      every: '1h',
      handler: () => {
        calls += 1;
        return Promise.reject(new Error('private defect'));
      },
    });
    const runtime = createScheduleRuntime({ schedules: [report], clock: 'host' });
    failContext = mode;
    await expect(runtime.trigger('report')).resolves.toMatchObject({
      status: 'handler-failed',
      cause: { code: 'failure.unexpected_defect' },
    });
    expect(calls).toBe(1);
    expect(runtime.handlerFailures).toBe(1);
    await runtime.stop();
  });

  it('keeps the business result when tracer or meter acquisition throws', async () => {
    vi.spyOn(trace, 'getTracer').mockImplementation(() => {
      throw new Error('tracer unavailable');
    });
    vi.spyOn(metrics, 'getMeter').mockImplementation(() => {
      throw new Error('meter unavailable');
    });
    const refusal = Refused({ secret: 'private' });
    const report = defineSchedule({ name: 'report', every: '1h', handler: () => Promise.resolve(refusal) });
    const runtime = createScheduleRuntime({ schedules: [report] });
    await expect(runtime.trigger('report')).resolves.toEqual({ name: 'report', status: 'refused', failure: refusal });
    expect(runtime.handlerFailures).toBe(1);
    await runtime.stop();
  });
});
