/**
 * Getting an outcome: `def.settled` and `def.startAndWait`. A wait never changes the run, so each test that ends a run
 * does it by the run's own means (a worker, a signal, a cancel) and the wait only reports. Real PGlite; a background
 * loop drains the jobs the way a worker would.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';
import { backoff } from '@arki/resilience';

import {
  CommandNotFound,
  WorkflowPending,
  WorkflowRunCancelled,
  WorkflowRunFailed,
} from '../errors.js';
import { j, openDb, tables } from '../test-support.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const input = z.object({ n: z.number() });
const noRetry = backoff.constant(0).upTo(0);

const quick = j
  .workflow('outcome.quick', { version: 1, input, output: z.string() })
  .step('work', ({ input: given }) => `n=${given.n}`)
  .finish(({ results }) => results.work);
const gated = j
  .workflow('outcome.gated', { version: 1, input, output: z.string() })
  .waitFor('go', { signal: 'go', schema: z.object({ word: z.string() }) })
  .finish(({ results }) => results.go.word);
const broken = j
  .workflow('outcome.broken', { version: 1, input, onDeadStep: 'compensate' })
  .step('work', () => {
    throw new Error('the card network is down');
  }, { retry: noRetry })
  .finish();

const journal = j.compose({ workflows: [quick, gated, broken], workflowMeta });
let db: PgliteDatabase;
let client: PGlite;
let stopPump = false;
let pumping: Promise<void> = Promise.resolve();

beforeAll(async () => {
  ({ db, client } = await openDb());
  stopPump = false;
  pumping = (async () => {
    while (!stopPump) {
      orThrow(await journal.drain(db, { leaseSeconds: 60 }));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  })();
});
afterAll(async () => {
  stopPump = true;
  await pumping;
  await client.close();
});

let next = 0;
const id = (prefix: string) => `${prefix}:${++next}`;

describe('def.startAndWait', () => {
  it('returns the output when the run completes', async () => {
    const result = await quick.startAndWait(db, { id: id('q'), input: { n: 3 } }, { meta: caller, timeout: 10 });
    expect(result).toBe('n=3');
  });

  it('returns WorkflowRunFailed with the recorded error when the run ends failed', async () => {
    const result = await broken.startAndWait(db, { id: id('b'), input: { n: 1 } }, { meta: caller, timeout: 10 });
    expect(WorkflowRunFailed.is(result)).toBe(true);
    if (!WorkflowRunFailed.is(result)) throw new Error('expected a failed run');
    expect(result.data.state).toBe('failed');
    // A thrown error is recorded redacted (its cause stays private), so the text names the defect, not the message.
    expect(result.data.error).toContain('failure.unexpected_defect');
  });

  it('returns WorkflowRunCancelled when the run is cancelled while the caller waits', async () => {
    const runId = id('c');
    const waiting = gated.startAndWait(db, { id: runId, input: { n: 1 } }, { meta: caller, timeout: 10 });
    await new Promise(resolve => setTimeout(resolve, 60));
    orThrow(await journal.run(db, gated.cancel, { runId, reason: 'changed my mind' }, caller));
    const result = await waiting;
    expect(WorkflowRunCancelled.is(result)).toBe(true);
    if (!WorkflowRunCancelled.is(result)) throw new Error('expected a cancelled run');
    expect(result.data).toEqual({ runId, reason: 'changed my mind' });
  });

  it('a timeout returns WorkflowPending with the run id, and does not cancel the run', async () => {
    const runId = id('t');
    const result = await gated.startAndWait(db, { id: runId, input: { n: 1 } }, { meta: caller, timeout: 0.1 });
    expect(WorkflowPending.is(result)).toBe(true);
    if (!WorkflowPending.is(result)) throw new Error('expected a timeout');
    expect(result.data.runId).toBe(runId);
    // The run is alive: a signal still completes it, and settled reports it.
    orThrow(await journal.run(db, gated.signal('go'), { runId, deliveryId: 'd1', payload: { word: 'late' } }, caller));
    const settled = await gated.settled(db, runId, { within: 10 });
    if (isFailure(settled)) throw new Error('expected the run');
    expect(settled.run).toMatchObject({ state: 'completed', output: 'late' });
  });

  it('an aborted signal ends the wait as a timeout does, and the run goes on', async () => {
    const runId = id('a');
    const controller = new AbortController();
    const waiting = gated.startAndWait(db, { id: runId, input: { n: 1 } }, { meta: caller, timeout: 20, signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 60));
    controller.abort();
    const result = await waiting;
    expect(WorkflowPending.is(result)).toBe(true);
    const [row] = await db.select({ state: tables.workflowRuns.state }).from(tables.workflowRuns).where(eq(tables.workflowRuns.id, runId));
    expect(row?.state).toBe('parked');
  });

  it('refuses a transaction handle and a bad timeout as misuse', async () => {
    await db.transaction(async tx => {
      // @ts-expect-error -- a transaction is not the root database.
      await expect(quick.startAndWait(tx, { input: { n: 1 } }, { meta: caller, timeout: 1 })).rejects.toThrow(/root database/);
    });
    await expect(quick.startAndWait(db, { input: { n: 1 } }, { meta: caller, timeout: 31 })).rejects.toThrow(/at most 30/);
    await expect(quick.startAndWait(db, { input: { n: 1 } }, { meta: caller, timeout: 0 })).rejects.toThrow(/above 0/);
  });
});

describe('def.settled', () => {
  it('returns the typed run once it has ended', async () => {
    const runId = id('s');
    orThrow(await journal.run(db, quick.start, { id: runId, input: { n: 7 } }, caller));
    const settled = await quick.settled(db, runId, { within: 10 });
    if (isFailure(settled)) throw new Error('expected the run');
    expect(settled.run).toMatchObject({ state: 'completed', output: 'n=7', input: { n: 7 } });
    expect(settled.run.results.work).toBe('n=7');
  });

  it('returns WorkflowPending with the run id while the run is open', async () => {
    const runId = id('p');
    orThrow(await journal.run(db, gated.start, { id: runId, input: { n: 1 } }, caller));
    const settled = await gated.settled(db, runId, { within: 0.1 });
    expect(WorkflowPending.is(settled)).toBe(true);
    if (!WorkflowPending.is(settled)) throw new Error('expected pending');
    expect(settled.data.runId).toBe(runId);
  });

  it('returns CommandNotFound for a run of another workflow, or none', async () => {
    const runId = id('o');
    orThrow(await journal.run(db, quick.start, { id: runId, input: { n: 1 } }, caller));
    expect(CommandNotFound.is(await gated.settled(db, runId, { within: 0.1 }))).toBe(true);
    expect(CommandNotFound.is(await gated.settled(db, 'no-such-run', { within: 0.1 }))).toBe(true);
  });

  it('refuses a transaction handle, and a missing, zero or too long within, as misuse', async () => {
    await db.transaction(async tx => {
      // @ts-expect-error -- a transaction is not the root database.
      await expect(quick.settled(tx, 'r', { within: 1 })).rejects.toThrow(/root database/);
    });
    // @ts-expect-error -- within is required.
    await expect(quick.settled(db, 'r', {})).rejects.toThrow(/within/);
    await expect(quick.settled(db, 'r', { within: 0 })).rejects.toThrow(/above 0/);
    await expect(quick.settled(db, 'r', { within: 31 })).rejects.toThrow(/at most 30/);
  });
});
