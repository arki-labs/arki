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
import { defineFailure } from '@arki/failure';

import type { PermitClaim } from './client';
import type { ForemanEnv } from './env';
import type { Permit } from './module';
import type { ReceiptStore } from './receipts';
import { createForemanClient, generateForemanKeyPair } from './client';
import { withCoreModules } from './core';
import { createForemanHandler } from './dispatcher';
import { foremanEnvShape } from './env';
import {
  ADMIN_ERROR_CODES,
  AdminError,
  defineAction,
  defineModule,
  defineRead,
  describeModule,
  isModuleError,
  moduleError,
} from './module';
import { kvReceiptStore, RECEIPT_WINDOW_SECONDS, receiptAnswerSchema } from './receipts';
import { memoryKv } from './test-support';

type Ctx = { tenant: string };
type KeyPair = Awaited<ReturnType<typeof generateForemanKeyPair>>;
type Behaviour = 'ok' | 'throw' | 'badOutput' | 'moduleError' | 'refused' | 'defect' | 'undeclared';
type ThrowAt = 'context' | 'read' | 'preview' | 'execute';
const Refused = defineFailure('admin.test_refused', { status: 409, message: 'The job changed.' });
const Defect = defineFailure('admin.test_defect', { status: 500, message: 'private database password' });
const Undeclared = defineFailure('admin.test_undeclared', {
  status: 409,
  message: 'private undeclared data',
  remediation: 'secret-remediation-sentinel',
});

/** Models untrusted callbacks that violate the returned-failure contract. */
function throwUndeclared(): never {
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- The regression requires a real thrown Failure value.
  throw Undeclared();
}

const AUD = 'novelette:prod';
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

function buildModule(behaviour: Behaviour, throwAt?: ThrowAt) {
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
      failures: [Refused, Defect, ...(behaviour === 'undeclared' ? [] : [Undeclared])],
      preview: (_input, _ctx: Ctx) => {
        if (throwAt === 'preview') throwUndeclared();
        return Promise.resolve({ revision: 'rev_3' });
      },
      execute: async ({ jobId }, _ctx: Ctx, permit) => {
        runs.push({ actionId: id, permit });
        if (throwAt === 'execute') throwUndeclared();
        if (behaviour === 'refused') return Refused({ cause: new Error('secret-cause-sentinel') });
        if (behaviour === 'defect') return Defect();
        // JavaScript callers can evade the declaration; the dispatcher must still fail closed.
        if (behaviour === 'undeclared') return Undeclared();
        if (behaviour === 'moduleError') {
          throw moduleError('ARKI_TEST_E001', 409, 'The job changed since the preview.', 'Preview again.');
        }
        if (behaviour === 'throw') throw new Error('database password leaked in this message');
        // Breaks the action's own output schema: it ran, then answered badly.
        if (behaviour === 'badOutput') return { requeued: true, jobId: 'not a job id' };
        return { requeued: true, jobId };
      },
    });
  const module = defineModule({
    id: '@arki/queue',
    version: '1.0.0',
    reads: {
      probe: defineRead({
        id: 'queue.probe',
        summary: 'Probe',
        permission: 'queue:read',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        load: (_input, _ctx: Ctx) => {
          if (throwAt === 'read') throwUndeclared();
          return Promise.resolve({ ok: true });
        },
      }),
    },
    actions: { retryJob: action('queue.retryJob'), dropJob: action('queue.dropJob') },
  });
  return { module, runs };
}

type SetupOptions = {
  behaviour?: Behaviour;
  throwAt?: ThrowAt;
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
  const receipts = options.receipts === null ? undefined : (options.receipts ?? kvReceiptStore(kv, { namespace: AUD }));
  const { module, runs } = buildModule(options.behaviour ?? 'ok', options.throwAt);
  const handler = createForemanHandler<Ctx>({
    identity: { aud: AUD, privateKey: appPair.privateKey },
    keys: { read: { current: readPair.publicKey }, execute: { current: executePair.publicKey } },
    writes: 'on',
    nonces: memoryKv(clock),
    receipts,
    modules: withCoreModules<Ctx>({
      app: { id: 'novelette', environment: 'prod', version: '1.2.3' },
      writes: 'on',
      health: () => ({ status: 'ok', checks: [] }),
      receipts,
      modules: [module],
    }),
    context: () => {
      if (options.throwAt === 'context') throwUndeclared();
      return { tenant: 'acme' };
    },
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
  it('supervises thrown failures before recording or replaying an execution receipt', async () => {
    const { execute, runs, receiptOf } = setup({ throwAt: 'execute' });
    const first = await execute('exe_thrown_failure').catch((error: unknown) => error);
    const second = await execute('exe_thrown_failure').catch((error: unknown) => error);
    const receipt = await receiptOf('exe_thrown_failure');
    expect(first).toMatchObject({ code: 'failure.unexpected_defect', status: 500 });
    expect(second).toMatchObject({ code: 'failure.unexpected_defect', status: 500 });
    expect(receipt).toMatchObject({ status: 'failed', error: { code: 'failure.unexpected_defect', status: 500 } });
    expect(runs).toHaveLength(1);
    for (const secret of [Undeclared.code, 'private undeclared data', 'secret-remediation-sentinel']) {
      expect(JSON.stringify({ first, second, receipt })).not.toContain(secret);
    }
  });

  it.each(['context', 'read', 'preview'] as const)(
    'supervises a failure thrown by %s before sending a response',
    async throwAt => {
      const { client, runs } = setup({ throwAt });
      const request =
        throwAt === 'read'
          ? client.read('queue.probe', {}, ['queue:read'])
          : client.preview('queue.retryJob', { jobId: 'job_1' }, ['queue:write']);
      const error = await request.catch((error_: unknown) => error_);
      expect(error).toMatchObject({ code: 'failure.unexpected_defect', status: 500 });
      expect(runs).toHaveLength(0);
      for (const secret of [Undeclared.code, 'private undeclared data', 'secret-remediation-sentinel']) {
        expect(JSON.stringify(error)).not.toContain(secret);
      }
    },
  );
  it.each(['refused', 'defect', 'undeclared'] as const)(
    'records a returned %s as failed and never reruns it',
    async behaviour => {
      const { execute, runs, receiptOf } = setup({ behaviour });
      const first = await execute('exe_returned_failure').catch((error: unknown) => error);
      const second = await execute('exe_returned_failure').catch((error: unknown) => error);
      const expected =
        behaviour === 'refused' ? Refused.code : behaviour === 'defect' ? Defect.code : 'failure.unexpected_defect';
      expect(first).toMatchObject({ code: expected });
      expect(second).toMatchObject({ code: expected });
      expect(runs).toHaveLength(1);
      const receipt = await receiptOf('exe_returned_failure');
      expect(receipt).toMatchObject({
        status: 'failed',
        error: { code: expected, status: behaviour === 'refused' ? 409 : 500 },
      });
      for (const secret of ['private database password', 'secret-cause-sentinel', 'private undeclared data']) {
        expect(JSON.stringify({ first, second, receipt })).not.toContain(secret);
      }
    },
  );
  it('settles the receipt before the response leaves the app', async () => {
    const order: string[] = [];
    const clock = new MockClock(T0);
    const inner = kvReceiptStore(memoryKv(clock), { namespace: AUD });
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
    await kvReceiptStore(kv, { namespace: AUD }).claim({
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

  // A repeat answers "applied" with the first result. If only the action id were
  // checked, the same execution id with other input (another job) or another
  // pinned revision would be told it applied, though that request never ran.
  it('the same execution id with other input or another revision is refused (E010), not answered as applied', async () => {
    const { client, execute, runs } = setup();
    await execute('exe_input');
    const otherJob = client.execute(
      'queue.retryJob',
      { jobId: 'job_2' },
      { scopes: ['queue:write'], permit: permit('exe_input', 'queue.retryJob') },
    );
    expect(await codeOf(otherJob)).toBe(ADMIN_ERROR_CODES.staleApproval);
    const otherRevision = client.execute(
      'queue.retryJob',
      { jobId: 'job_1' },
      { scopes: ['queue:write'], permit: { ...permit('exe_input', 'queue.retryJob'), expectedRevision: 'rev_4' } },
    );
    expect(await codeOf(otherRevision)).toBe(ADMIN_ERROR_CODES.staleApproval);
    expect(runs).toHaveLength(1);
  });

  // An execution that spans the upgrade must not be sent back for approval:
  // a second approval would run an action that already applied.
  it('a receipt written before requestHash existed still answers a true repeat, matched by action id', async () => {
    const clock = new MockClock(T0);
    const inner = kvReceiptStore(memoryKv(clock), { namespace: AUD });
    const legacy: ReceiptStore = {
      claim: async receipt => {
        const result = await inner.claim(receipt);
        if (result.claimed || result.receipt === undefined) return result;
        const { requestHash: _dropped, ...older } = result.receipt;
        return { claimed: false, receipt: older };
      },
      get: executionId => inner.get(executionId),
      settle: receipt => inner.settle(receipt),
    };
    const { execute, runs } = setup({ receipts: legacy });
    const first = await execute('exe_legacy');
    expect(await execute('exe_legacy')).toEqual(first);
    expect(await codeOf(execute('exe_legacy', 'queue.dropJob'))).toBe(ADMIN_ERROR_CODES.staleApproval);
    expect(runs).toHaveLength(1);
  });

  it('the same execution id on another action is refused (E010) and nothing runs', async () => {
    const { execute, runs } = setup();
    await execute('exe_bound', 'queue.retryJob');
    expect(await codeOf(execute('exe_bound', 'queue.dropJob'))).toBe(ADMIN_ERROR_CODES.staleApproval);
    expect(runs.map(run => run.actionId)).toEqual(['queue.retryJob']);
  });
});

describe('T(admin-receipts) a module declares its own errors', () => {
  it('an action that throws a ModuleError answers its own status and code over the signed protocol, and a repeat answers the same', async () => {
    const { execute, receiptOf } = setup({ behaviour: 'moduleError' });
    const error: unknown = await execute('exe_mod').then(
      () => null,
      (error_: unknown) => error_,
    );
    expect(isModuleError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'ARKI_TEST_E001', status: 409, remediation: 'Preview again.' });
    expect(await receiptOf('exe_mod')).toMatchObject({
      status: 'failed',
      error: { code: 'ARKI_TEST_E001', status: 409 },
    });
    expect(await execute('exe_mod').catch((error_: unknown) => error_)).toMatchObject({
      code: 'ARKI_TEST_E001',
      status: 409,
    });
  });

  it('ModuleError carries canonical server failures and rejects statuses outside the HTTP error range', () => {
    for (const status of [399, 600, 409.5]) {
      expect(() => moduleError('ARKI_TEST_E002', status, 'no', 'no')).toThrow(ADMIN_ERROR_CODES.invalidConfig);
    }
    expect(moduleError('ARKI_TEST_E002', 404, 'ok', 'ok').status).toBe(404);
    expect(moduleError('ARKI_TEST_E002', 500, 'private', 'ok').status).toBe(500);
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
      get: executionId => kvReceiptStore(memoryKv(new MockClock(T0)), { namespace: AUD }).get(executionId),
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
  it('two apps on one KV never see each other’s receipts: every key carries the namespace', async () => {
    const kv = memoryKv(new MockClock(T0));
    const novelette = kvReceiptStore(kv, { namespace: 'novelette:prod' });
    const brandability = kvReceiptStore(kv, { namespace: 'brandability:prod' });
    const claim = {
      status: 'pending',
      executionId: 'exe_shared',
      actionId: 'queue.retryJob',
      claimedAt: T0.toISOString(),
    } as const;
    expect(await novelette.claim(claim)).toEqual({ claimed: true });
    expect(await brandability.get('exe_shared')).toBeUndefined();
    // The other app's claim on the same id is its own, not "already taken".
    expect(await brandability.claim(claim)).toEqual({ claimed: true });
    expect(await novelette.get('exe_shared')).toMatchObject({ status: 'pending' });
    expect(
      [...kv.entries.keys()].every(key => key.includes('novelette:prod') || key.includes('brandability:prod')),
    ).toBe(true);
  });

  it('refuses a namespace that is missing or could slip into another key', () => {
    const kv = memoryKv(new MockClock(T0));
    for (const namespace of ['', 'novelette', 'novelette:prod:claim', 'a:b:value:x', 'Nove lette:prod', 'novelette:']) {
      expect(() => kvReceiptStore(kv, { namespace })).toThrow(/ARKI_ADMIN_E014/);
    }
  });

  it('refuses to keep receipts shorter than Foreman’s receipt window', () => {
    const kv = memoryKv(new MockClock(T0));
    expect(() => kvReceiptStore(kv, { namespace: AUD, ttlSeconds: RECEIPT_WINDOW_SECONDS - 1 })).toThrow(
      /ARKI_ADMIN_E014/,
    );
    expect(() => kvReceiptStore(kv, { namespace: AUD, ttlSeconds: RECEIPT_WINDOW_SECONDS })).not.toThrow();
  });

  it('still holds an applied receipt a day after the window, so a late reconcile is not misread', async () => {
    const { execute, receiptOf, clock } = setup();
    await execute('exe_late');
    clock.advance(24 * 60 * 60 * 1000);
    expect(await receiptOf('exe_late')).toMatchObject({ status: 'applied' });
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
