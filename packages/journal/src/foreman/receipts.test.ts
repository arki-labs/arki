/**
 * T(journal-foreman-receipts) — the Postgres receipt store on the journal. Why it matters: an execute
 * whose answer was lost must still have a receipt behind it, and two racing claims for one execution id
 * must never both run the action.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { SettledReceipt } from '@arki/admin/receipts';
import { defineAction, defineModule } from '@arki/admin/module';
import { isFailure } from '@arki/failure';

import { initJournal } from '../index.js';
import { journalTables } from '../pg.js';
import { openJournalDb } from '../testing.js';
import { foremanReceiptTables, journalReceiptStore } from './receipts.js';
import { foremanHarness } from './test-support.js';

const T0 = '2026-10-14T12:00:00.000Z';

/** A journal receipt store on an in-memory Postgres, the way a DOT app builds it. */
async function journalStore() {
  const tables = journalTables();
  const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
  const receiptTables = foremanReceiptTables();
  const journal = j.compose({});
  const { db } = await openJournalDb({ ...tables, ...receiptTables });
  return journalReceiptStore({ j, journal, db, tables: receiptTables, meta: { actorId: 'foreman' } });
}

describe('T(journal-foreman-receipts) the journal store', () => {
  it('records claim then settle as journal events, and a repeat sees the stored receipt', async () => {
    const store = await journalStore();
    const pending = { status: 'pending', executionId: 'exe_j1', actionId: 'queue.retryJob', claimedAt: T0 } as const;
    expect(await store.claim(pending)).toEqual({ claimed: true });
    expect(await store.claim(pending)).toEqual({ claimed: false, receipt: pending });
    const applied: SettledReceipt = { ...pending, status: 'applied', appliedAt: T0, result: { requeued: true } };
    await store.settle(applied);
    expect(await store.get('exe_j1')).toEqual(applied);
    expect(await store.get('exe_unknown')).toBeUndefined();
  });

  it('of two concurrent claims for one id exactly one wins', async () => {
    const store = await journalStore();
    const pending = { status: 'pending', executionId: 'exe_race', actionId: 'queue.retryJob', claimedAt: T0 } as const;
    const results = await Promise.all([store.claim(pending), store.claim(pending)]);
    expect(results.filter(result => result.claimed)).toHaveLength(1);
  });

  it('serves a lost answer end to end through the handler, and the action ran once', async () => {
    const store = await journalStore();
    let runs = 0;
    const module = defineModule({
      id: '@arki/queue',
      version: '1.0.0',
      reads: {},
      actions: {
        retryJob: defineAction({
          id: 'queue.retryJob',
          summary: 'Retry a job',
          permission: 'queue:write',
          risk: 'low',
          input: z.object({ jobId: z.string().min(1) }),
          previewOutput: z.object({ revision: z.string() }),
          output: z.object({ requeued: z.boolean() }),
          preview: () => Promise.resolve({ revision: 'rev_3' }),
          execute: () => {
            runs += 1;
            return Promise.resolve({ requeued: true });
          },
        }),
      },
    });
    const { client, permit, receiptOf } = await foremanHarness(module, { receipts: store, loseExecuteAnswers: true });
    const execute = () =>
      client.execute(
        'queue.retryJob',
        { jobId: 'job_1' },
        { scopes: ['queue:write'], permit: permit('exe_journal', 'queue.retryJob', 'rev_3') },
      );
    // The answer is lost on the wire both times; the client returns that as a failure value.
    expect(isFailure(await execute())).toBe(true);
    expect(isFailure(await execute())).toBe(true);
    expect(await receiptOf('exe_journal')).toMatchObject({ status: 'applied', result: { requeued: true } });
    expect(runs).toBe(1);
  });
});
