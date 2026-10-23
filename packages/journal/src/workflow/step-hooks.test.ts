/**
 * `journal.hooks.step` on PGlite. A step hook is the app's one place to wrap every step body and undo: a timer, a
 * tenant context, a lock. It must see which run, node, try and phase it wraps (and never the input or results, which
 * may be private), wrap the body and the undo both, sit inside the `journal.step` span so its own spans nest under the
 * step, and refuse registration once steps may already have run without it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PGlite } from '@electric-sql/pglite';
import type { Context, ContextManager } from '@opentelemetry/api';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { IdGenerationFailure } from '@arki/contracts';
import { defineFailure, orThrow } from '@arki/failure';

import type { j as sharedJournal } from '../test-support.js';
import type { StepHookContext } from '../types.js';
import { JournalError } from '../errors.js';
import { initJournal } from '../journal.js';
import { tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const caller = { actorId: 'usr_test' };
const workflowMeta = { actorId: 'system:workflow' };
type Init = typeof sharedJournal;
const fresh = (): Init => initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });

const Declined = defineFailure('test.step_hooks_declined', { status: 409 });

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

beforeEach(async () => {
  ({ db, client } = await openJournalDb(tables));
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(manager);
});
afterEach(async () => {
  await client.close();
  await provider.shutdown();
  trace.disable();
  context.disable();
});

type Draining = { readonly drain: (db: PgliteDatabase) => Promise<number | IdGenerationFailure> };
async function settle(journal: Draining, limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the runs did not settle');
}

describe('journal.hooks.step', () => {
  it('wraps each step body and undo, with the run, node, try and phase, and nothing more', async () => {
    const init = fresh();
    const log: string[] = [];
    const order = init
      .workflow('test.stepHooks.order', {
        version: 3,
        input: z.object({ secret: z.string() }),
        onDeadStep: 'compensate',
      })
      .step('reserve', () => void log.push('body reserve'), { undo: () => void log.push('undo reserve') })
      .step('charge', () => {
        log.push('body charge');
        return Declined({});
      })
      .finish();
    const journal = init.compose({ workflows: [order], workflowMeta });
    const seen: StepHookContext[] = [];
    journal.hooks.step.around(async (ctx, next) => {
      seen.push(ctx);
      log.push(`before ${ctx.step} ${ctx.phase}`);
      await next();
      log.push(`after ${ctx.step} ${ctx.phase}`);
    });

    orThrow(await journal.run(db, order.start, { input: { secret: 'hidden' }, id: 'run_hooks_1' }, caller));
    await settle(journal);

    expect(log).toEqual([
      'before reserve do',
      'body reserve',
      'after reserve do',
      'before charge do',
      'body charge',
      'after charge do',
      'before reserve undo',
      'undo reserve',
      'after reserve undo',
    ]);
    const base = { workflow: 'test.stepHooks.order', version: 3, runId: 'run_hooks_1', attempt: 1 };
    expect(seen).toEqual([
      { ...base, step: 'reserve', phase: 'do' },
      { ...base, step: 'charge', phase: 'do' },
      { ...base, step: 'reserve', phase: 'undo' },
    ]);
    expect(seen.every(ctx => Object.isFrozen(ctx))).toBe(true);
  });

  it('runs inside the journal.step span, so a span the hook starts is a child of the step', async () => {
    const init = fresh();
    const report = init.task('test.stepHooks.span', { version: 1, input: z.object({}) }, () => 'done');
    const journal = init.compose({ workflows: [report], workflowMeta });
    const parents: (string | undefined)[] = [];
    journal.hooks.step.around(async (_ctx, next) => {
      parents.push(trace.getActiveSpan()?.spanContext().spanId);
      await next();
    });

    orThrow(await journal.run(db, report.start, { input: {}, id: 'run_hooks_span' }, caller));
    await settle(journal);
    const steps = exporter.getFinishedSpans().filter(span => span.name === 'journal.step');
    expect(steps).toHaveLength(1);
    expect(parents).toEqual([steps[0]?.spanContext().spanId]);
  });

  it('cannot be registered once the journal has drained, since steps may have run without it', async () => {
    const init = fresh();
    const report = init.task('test.stepHooks.frozen', { version: 1, input: z.object({}) }, () => 'done');
    const journal = init.compose({ workflows: [report], workflowMeta });
    await settle(journal);
    let refused: unknown;
    try {
      journal.hooks.step.around((_ctx, next) => next());
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(JournalError);
    expect(refused instanceof JournalError ? refused.code : undefined).toBe('BAD_DEFINITION');
  });
});
