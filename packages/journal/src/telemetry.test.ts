/**
 * The journal's spans, through a real journal on PGlite. They matter because `docs/arki/principles.md` makes jobs and
 * workflow attempts default-instrumented boundaries: an operator must see which command, effect or step ran, how it
 * ended, and under which parent, without any payload leaking into the trace, and a broken tracer must never change a
 * result.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PGlite } from '@electric-sql/pglite';
import type { Context, ContextManager } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { context, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defineFailure, orThrow } from '@arki/failure';

import { j, tables } from './test-support.js';
import { openJournalDb } from './testing.js';

const caller = { actorId: 'usr_test' };
const SECRET = 'never-collect-this';

const Declined = defineFailure('test.telemetry_declined', { status: 409, data: z.object({ reason: z.string() }) });

const approve = j.command('test.telemetry.approve', z.object({ note: z.string() }), () =>
  Promise.resolve({ approved: true }),
);
const decline = j.command('test.telemetry.decline', z.object({ note: z.string() }), ({ note }) =>
  Promise.resolve(Declined({ reason: note })),
);

const report = j
  .workflow('test.telemetry.report', { version: 1, input: z.object({ secret: z.string() }) })
  .step('render', ({ input }) => ({ length: input.secret.length }))
  .finish();

const journal = j.compose({ workflows: [report], workflowMeta: { actorId: 'system:workflow' } });

const storage = new AsyncLocalStorage<Context>();
const manager: ContextManager = {
  active: () => storage.getStore() ?? ROOT_CONTEXT,
  with: (next, fn, thisArg, ...args) => storage.run(next, () => fn.apply(thisArg, args)),
  bind: (_next, target) => target,
  enable: () => manager,
  disable: () => manager,
};

let db: PgliteDatabase;
let client: PGlite;
let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(manager);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await provider.shutdown();
  trace.disable();
  context.disable();
});

const spansNamed = (name: string) => exporter.getFinishedSpans().filter(span => span.name === name);
const only = (name: string): ReadableSpan => {
  const spans = spansNamed(name);
  expect(spans).toHaveLength(1);
  const [span] = spans;
  if (span === undefined) throw new Error(`no ${name} span`);
  return span;
};
const leaks = (span: ReadableSpan) => JSON.stringify(span.attributes).includes(SECRET);

describe('journal.command', () => {
  it('names the command and its ids, ends ok, and carries no input', async () => {
    orThrow(await journal.run(db, approve, { note: SECRET }, caller));
    const span = only('journal.command');
    expect(span.attributes).toMatchObject({
      'journal.command.name': 'test.telemetry.approve',
      'journal.command.idempotent': false,
      'journal.outcome': 'ok',
    });
    expect(span.attributes['journal.command.id']).toEqual(expect.any(String));
    expect(leaks(span)).toBe(false);
  });

  it('a returned refusal is a classified failure with its code, not an exception event', async () => {
    const result = await journal.run(db, decline, { note: SECRET }, caller);
    expect(Declined.is(result)).toBe(true);
    const span = only('journal.command');
    expect(span.attributes).toMatchObject({ 'journal.outcome': 'failure', 'failure.code': Declined.code });
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events).toEqual([]);
    expect(leaks(span)).toBe(false);
  });

  it('a tracer that throws changes nothing: the command runs once and returns its own result', async () => {
    vi.spyOn(trace, 'getTracer').mockImplementation(() => {
      throw new Error('tracer unavailable');
    });
    expect(await journal.run(db, approve, { note: 'x' }, caller)).toEqual({ approved: true });
  });
});

describe('journal.effect and journal.step', () => {
  it('a step body runs inside its effect span, named by run, node and try, with no input', async () => {
    const started = orThrow(await journal.run(db, report.start, { input: { secret: SECRET } }, caller));
    exporter.reset();
    for (let pass = 0; pass < 10; pass++) {
      if ((await journal.drain(db).then(result => orThrow(result))) === 0) break;
    }
    const step = only('journal.step');
    expect(step.attributes).toMatchObject({
      'journal.workflow.name': 'test.telemetry.report',
      'journal.workflow.version': 1,
      'journal.workflow.run_id': started.runId,
      'journal.step.name': 'render',
      'journal.step.attempt': 1,
      'journal.step.phase': 'do',
      'journal.outcome': 'ok',
    });
    const effect = spansNamed('journal.effect').find(
      span => span.spanContext().spanId === step.parentSpanContext?.spanId,
    );
    expect(effect?.attributes).toMatchObject({ 'journal.effect.name': 'workflow.step', 'journal.outcome': 'ok' });
    expect(exporter.getFinishedSpans().some(span => leaks(span))).toBe(false);
  });
});
