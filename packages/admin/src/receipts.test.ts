/**
 * T(admin-receipts) — Foreman settles an execute whose answer was lost by
 * reading the app's receipt. These tests pin why each rule exists:
 *  - the receipt is settled before the response leaves, so a lost response
 *    still has a receipt behind it;
 *  - one execution id runs its action once, whatever repeats arrive;
 *  - no execute runs without a receipt store (fail closed);
 *  - the receipt read needs the read scope, like every other read.
 */
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import { MockClock } from '@arki/clock';
import { z } from '@arki/contracts';
import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';

import type { PermitClaim } from './client';
import type { ForemanEnv } from './env';
import type { Permit } from './module';
import type { ReceiptStore, SettledReceipt } from './receipts';
import { createForemanClient, generateForemanKeyPair } from './client';
import { withCoreModules } from './core';
import { createForemanHandler } from './dispatcher';
import { foremanEnvShape } from './env';
import { ADMIN_ERROR_CODES, AdminError, defineAction, defineModule, describeModule } from './module';
import { foremanReceiptTables, journalReceiptStore } from './pg';
import { kvReceiptStore, RECEIPT_WINDOW_SECONDS, receiptAnswerSchema } from './receipts';
import { memoryKv } from './test-support';

type Ctx = { tenant: string };
type KeyPair = Awaited<ReturnType<typeof generateForemanKeyPair>>;
type Behaviour = 'ok' | 'throw' | 'badOutput';

const AUD = 'novelette:production';
const BASE_URL = 'https://novelette.test';
const T0 = new Date('2026-10-14T12:00:00Z');

let readPair: KeyPair;
let executePair: KeyPair;
let appPair: KeyPair;
let hashes: Map<string, string>;

beforeAll(async () => {
  [readPair, executePair, appPair] = await Promise.all([
    generateForemanKeyPair(),
    generateForemanKeyPair(),
    generateForemanKeyPair(),
  ]);
  const description = await describeModule(buildModule('ok').module);
  hashes = new Map(description.actions.map(action => [action.id, action.schemaHash]));
});

function buildModule(behaviour: Behaviour) {
  const runs: { actionId: string; permit: Permit }[] = [];
  const action = (id: string) =>
    defineAction({
      id,
      summary: `Run ${id}`,
      permission: 'queue:write',
      risk: 'low',
      input: z.object({ jobId: z.string().min(1) }),
      previewOutput: z.object({ revision: z.string() }),
      output: z.object({ requeued: z.boolean(), jobId: z.string().regex(/^job_\d+$/) }),
      preview: (_input, _ctx: Ctx) => Promise.resolve({ revision: 'rev_3' }),
      execute: ({ jobId }, _ctx: Ctx, permit) => {
        runs.push({ actionId: id, permit });
        if (behaviour === 'throw') return Promise.reject(new Error('database password leaked in this message'));
        // Breaks the action's own output schema: it ran, then answered badly.
        if (behaviour === 'badOutput') return Promise.resolve({ requeued: true, jobId: 'not a job id' });
        return Promise.resolve({ requeued: true, jobId });
      },
    });
  const module = defineModule({
    id: '@arki/queue',
    version: '1.0.0',
    reads: {},
    actions: { retryJob: action('queue.retryJob'), dropJob: action('queue.dropJob') },
  });
  return { module, runs };
}

type SetupOptions = {
  behaviour?: Behaviour;
  /** `null`: no receipt store at all. Default: a KV store on the test clock. */
  receipts?: ReceiptStore | null;
  /** The network loses every execute answer after the app handled it. */
  loseExecuteAnswers?: boolean;
  /** Called after the handler resolved, before the client sees the response. */
  onResponse?: () => void;
};

function setup(options: SetupOptions = {}) {
  const clock = new MockClock(T0);
  const kv = memoryKv(clock);
  const receipts = options.receipts === null ? undefined : (options.receipts ?? kvReceiptStore(kv));
  const { module, runs } = buildModule(options.behaviour ?? 'ok');
  const handler = createForemanHandler<Ctx>({
    identity: { aud: AUD, privateKey: appPair.privateKey },
    keys: { read: { current: readPair.publicKey }, execute: { current: executePair.publicKey } },
    writes: 'on',
    nonces: memoryKv(clock),
    receipts,
    modules: withCoreModules<Ctx>({
      app: { id: 'novelette', environment: 'production', version: '1.2.3' },
      writes: 'on',
      health: () => ({ status: 'ok', checks: [] }),
      receipts,
      modules: [module],
    }),
    context: () => ({ tenant: 'acme' }),
    app: { version: '1.2.3' },
    clock,
  });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await handler(request);
    options.onResponse?.();
    if (options.loseExecuteAnswers === true && new URL(request.url).pathname.endsWith('/execute')) {
      throw new TypeError('socket hang up');
    }
    return response;
  };
  const client = createForemanClient({
    target: { aud: AUD, baseUrl: BASE_URL, appKey: appPair.publicKey },
    readKey: readPair.privateKey,
    executeKey: executePair.privateKey,
    clock,
    fetch: fetchImpl,
  });
  const execute = (executionId: string, actionId = 'queue.retryJob') =>
    client.execute(actionId, { jobId: 'job_1' }, { scopes: ['queue:write'], permit: permit(executionId, actionId) });
  const receiptOf = async (executionId: string) =>
    receiptAnswerSchema.parse(await client.read('core.receipts.get', { executionId }, ['core:read']));
  return { clock, kv, client, runs, execute, receiptOf };
}

function permit(executionId: string, actionId: string): PermitClaim {
  return { executionId, expectedRevision: 'rev_3', approvedBy: 'usr_alex', schemaHash: hashes.get(actionId) ?? '' };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await adminErrorOf(promise);
  return error.code;
}

async function adminErrorOf(promise: Promise<unknown>): Promise<AdminError> {
  const error: unknown = await promise.then(
    () => null,
    (error_: unknown) => error_,
  );
  if (!(error instanceof AdminError)) throw new Error(`expected an AdminError, got ${String(error)}`);
  return error;
}

describe('T(admin-receipts) the dispatcher records every execute', () => {
  it('settles the receipt before the response leaves the app', async () => {
    const order: string[] = [];
    const clock = new MockClock(T0);
    const inner = kvReceiptStore(memoryKv(clock));
    // A slow store: a settle that is not awaited would land after the response.
    const slow: ReceiptStore = {
      claim: receipt => inner.claim(receipt),
      get: executionId => inner.get(executionId),
      settle: async receipt => {
        await new Promise(resolve => setTimeout(resolve, 20));
        await inner.settle(receipt);
        order.push(`settled:${receipt.status}`);
      },
    };
    const { execute } = setup({ receipts: slow, onResponse: () => order.push('response') });
    await execute('exe_order');
    expect(order).toEqual(['settled:applied', 'response']);
  });

  it('a lost answer is settled by core.receipts.get: applied, with the result and its hash', async () => {
    const { execute, receiptOf, runs } = setup({ loseExecuteAnswers: true });
    await expect(execute('exe_lost')).rejects.toThrow();
    const receipt = await receiptOf('exe_lost');
    expect(receipt).toMatchObject({
      status: 'applied',
      executionId: 'exe_lost',
      actionId: 'queue.retryJob',
      result: { requeued: true, jobId: 'job_1' },
    });
    expect(receipt.status === 'applied' ? receipt.resultHash : undefined).toMatch(/^sha256:[\da-f]{64}$/);
    expect(runs).toHaveLength(1);
  });

  it('an execution id it never saw reads not_applied at once: deciding when that is final is Foreman’s job', async () => {
    const { receiptOf } = setup();
    expect(await receiptOf('exe_never_sent')).toEqual({ status: 'not_applied', executionId: 'exe_never_sent' });
  });

  it('a repeated execute answers from the receipt and never runs the action twice', async () => {
    const { execute, runs } = setup();
    const first = await execute('exe_once');
    const second = await execute('exe_once');
    expect(second).toEqual(first);
    expect(runs).toHaveLength(1);
  });

  it('a repeated execute of a failed action fails the same way without running again', async () => {
    const { execute, runs, receiptOf } = setup({ behaviour: 'throw' });
    const first = await adminErrorOf(execute('exe_fail'));
    const second = await adminErrorOf(execute('exe_fail'));
    expect(first.code).toBe(ADMIN_ERROR_CODES.handlerFailed);
    expect(second.code).toBe(ADMIN_ERROR_CODES.handlerFailed);
    expect(runs).toHaveLength(1);
    const receipt = await receiptOf('exe_fail');
    expect(receipt).toMatchObject({ status: 'failed', error: { code: ADMIN_ERROR_CODES.handlerFailed } });
    // The read key sees what the wire saw, never the app's internal error message.
    expect(JSON.stringify(receipt)).not.toContain('password');
  });

  it('an execution still pending refuses the repeat with E018 and does not run it', async () => {
    const { execute, runs, kv, receiptOf } = setup();
    // Another instance claimed it and is still running (or died mid-action).
    await kvReceiptStore(kv).claim({
      status: 'pending',
      executionId: 'exe_busy',
      actionId: 'queue.retryJob',
      claimedAt: T0.toISOString(),
    });
    expect(await codeOf(execute('exe_busy'))).toBe(ADMIN_ERROR_CODES.executionInProgress);
    expect(runs).toHaveLength(0);
    expect(await receiptOf('exe_busy')).toMatchObject({ status: 'pending' });
  });

  it('an action that ran but broke its output schema is recorded applied, not failed', async () => {
    const { execute, receiptOf, runs } = setup({ behaviour: 'badOutput' });
    expect(await codeOf(execute('exe_bad_output'))).toBe(ADMIN_ERROR_CODES.invalidOutput);
    expect(await receiptOf('exe_bad_output')).toMatchObject({ status: 'applied', result: null });
    expect(runs).toHaveLength(1);
  });

  it('the same execution id on another action is refused (E010) and nothing runs', async () => {
    const { execute, runs } = setup();
    await execute('exe_bound', 'queue.retryJob');
    expect(await codeOf(execute('exe_bound', 'queue.dropJob'))).toBe(ADMIN_ERROR_CODES.staleApproval);
    expect(runs.map(run => run.actionId)).toEqual(['queue.retryJob']);
  });
});

describe('T(admin-receipts) fail closed', () => {
  it('writes on and no receipt store: every execute is refused with E017 and nothing runs', async () => {
    const { execute, runs, client } = setup({ receipts: null });
    expect(await codeOf(execute('exe_no_store'))).toBe(ADMIN_ERROR_CODES.receiptsUnavailable);
    expect(runs).toHaveLength(0);
    // Nothing to read either: the target serves no receipts module.
    const error = await adminErrorOf(client.read('core.receipts.get', { executionId: 'exe_no_store' }, ['core:read']));
    expect(error.code).toBe(ADMIN_ERROR_CODES.unknownCapability);
  });

  it('a store that cannot take the claim refuses with E017 before the action runs', async () => {
    const broken: ReceiptStore = {
      claim: () => Promise.reject(new Error('redis down')),
      settle: () => Promise.resolve(),
      get: executionId => kvReceiptStore(memoryKv(new MockClock(T0))).get(executionId),
    };
    const { execute, runs } = setup({ receipts: broken });
    expect(await codeOf(execute('exe_store_down'))).toBe(ADMIN_ERROR_CODES.receiptsUnavailable);
    expect(runs).toHaveLength(0);
  });
});

describe('T(admin-receipts) the receipt read', () => {
  it('needs a scope that covers core:read', async () => {
    const { client } = setup();
    const error = await adminErrorOf(client.read('core.receipts.get', { executionId: 'exe_1' }, ['queue:read']));
    expect(error.code).toBe(ADMIN_ERROR_CODES.scopeDenied);
  });

  it('rejects an execution id longer than any Foreman issues', async () => {
    const { client } = setup();
    const error = await adminErrorOf(client.read('core.receipts.get', { executionId: 'x'.repeat(129) }, ['core:read']));
    expect(error.code).toBe(ADMIN_ERROR_CODES.invalidInput);
  });
});

describe('T(admin-receipts) the KV store', () => {
  it('refuses to keep receipts shorter than Foreman’s receipt window', () => {
    const kv = memoryKv(new MockClock(T0));
    expect(() => kvReceiptStore(kv, { ttlSeconds: RECEIPT_WINDOW_SECONDS - 1 })).toThrow(/ARKI_ADMIN_E014/);
    expect(() => kvReceiptStore(kv, { ttlSeconds: RECEIPT_WINDOW_SECONDS })).not.toThrow();
  });

  it('still holds an applied receipt a day after the window, so a late reconcile is not misread', async () => {
    const { execute, receiptOf, clock } = setup();
    await execute('exe_late');
    clock.advance(24 * 60 * 60 * 1000);
    expect(await receiptOf('exe_late')).toMatchObject({ status: 'applied' });
  });
});

/** A journal receipt store on an in-memory Postgres, the way a DOT app builds it. */
async function journalStore() {
  const j = initJournal({ meta: z.object({ actorId: z.string().min(1) }) });
  const tables = journalTables();
  const receiptTables = foremanReceiptTables();
  const journal = j.compose({ tables });
  const { db } = await openJournalDb({ ...tables, ...receiptTables });
  const store = journalReceiptStore({ j, journal, db, tables: receiptTables, meta: { actorId: 'foreman' } });
  return { store };
}

describe('T(admin-receipts) the journal store', () => {
  it('records claim then settle as journal events, and a repeat sees the stored receipt', async () => {
    const { store } = await journalStore();
    const pending = {
      status: 'pending',
      executionId: 'exe_j1',
      actionId: 'queue.retryJob',
      claimedAt: T0.toISOString(),
    } as const;
    expect(await store.claim(pending)).toEqual({ claimed: true });
    expect(await store.claim(pending)).toEqual({ claimed: false, receipt: pending });
    const applied: SettledReceipt = {
      ...pending,
      status: 'applied',
      appliedAt: T0.toISOString(),
      result: { requeued: true },
    };
    await store.settle(applied);
    expect(await store.get('exe_j1')).toEqual(applied);
    expect(await store.get('exe_unknown')).toBeUndefined();
  });

  it('of two concurrent claims for one id exactly one wins', async () => {
    const { store } = await journalStore();
    const pending = {
      status: 'pending',
      executionId: 'exe_race',
      actionId: 'queue.retryJob',
      claimedAt: T0.toISOString(),
    } as const;
    const results = await Promise.all([store.claim(pending), store.claim(pending)]);
    expect(results.filter(result => result.claimed)).toHaveLength(1);
  });

  it('serves a lost answer end to end through the handler', async () => {
    const { store } = await journalStore();
    const { execute, receiptOf, runs } = setup({ receipts: store, loseExecuteAnswers: true });
    await expect(execute('exe_journal')).rejects.toThrow();
    expect(await execute('exe_journal').catch(() => 'lost again')).toBe('lost again');
    expect(await receiptOf('exe_journal')).toMatchObject({ status: 'applied', result: { requeued: true } });
    expect(runs).toHaveLength(1);
  });
});

describe('ForemanEnv', () => {
  it('is what an env schema built from foremanEnvShape parses to', () => {
    const env = z.object({ PORT: z.string(), ...foremanEnvShape }).parse({ PORT: '3000' });
    expectTypeOf(env).toExtend<ForemanEnv>();
    const noKeys: ForemanEnv = {};
    expect(noKeys).toEqual({});
  });
});
