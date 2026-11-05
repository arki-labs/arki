/**
 * Each approved execute runs inside one `admin.action.execute` span that names the action and what
 * became of its receipt. An operator reads a failed or repeated Foreman action from its trace, next to
 * the request that carried it, and never finds the input, the approver or a key there.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { SpanCapture } from '@arki/testing/otel';
import { MockClock } from '@arki/clock';
import { z } from '@arki/contracts';
import { defineFailure, orThrow } from '@arki/failure';
import { buildEngine } from '@arki/http';
import { captureSpans } from '@arki/testing/otel';

import type { NonceStore } from './dispatcher.ts';
import type { ForemanEnv } from './env.ts';
import type { ForemanAppOptions } from './foreman-app.ts';
import { createForemanClient, generateForemanKeyPair } from './client.ts';
import { foreman } from './dot.ts';
import { createForemanHandlerFromEnv } from './foreman-app.ts';
import { defineAction, defineModule, describeModule } from './module.ts';
import { kvReceiptStore } from './receipts.ts';
import { observeExecute } from './telemetry.ts';
import { memoryKv } from './test-support.ts';

type KeyPair = Awaited<ReturnType<typeof generateForemanKeyPair>>;
type Ctx = { tenant: string };

const APP_ID = 'novelette';
const ENVIRONMENT = 'prod';
const BASE_URL = 'https://novelette.test';
const T0 = new Date('2026-10-14T12:00:00Z');
const SCOPES = ['queue:*'];

const JobChanged = defineFailure('admin.test_job_changed', { status: 409, message: 'The job changed.' });
const StoreDown = defineFailure('admin.test_store_down', { status: 503 });

let readPair: KeyPair;
let executePair: KeyPair;
let appPair: KeyPair;
let hashes: Map<string, string>;

function queueModule() {
  const action = (id: string, execute: () => Promise<{ requeued: boolean } | ReturnType<typeof JobChanged>>) =>
    defineAction({
      id,
      summary: `Run ${id}`,
      permission: 'queue:write',
      risk: 'low',
      input: z.object({ jobId: z.string().min(1) }),
      previewOutput: z.object({ revision: z.string() }),
      output: z.object({ requeued: z.boolean() }),
      failures: [JobChanged],
      preview: (_input, _ctx: Ctx) => Promise.resolve({ revision: 'rev_3' }),
      execute,
    });
  return defineModule({
    id: '@arki/queue',
    version: '1.0.0',
    reads: {},
    actions: {
      retryJob: action('queue.retryJob', () => Promise.resolve({ requeued: true })),
      dropJob: action('queue.dropJob', () => Promise.resolve(JobChanged())),
    },
  });
}

beforeAll(async () => {
  [readPair, executePair, appPair] = await Promise.all([
    generateForemanKeyPair(),
    generateForemanKeyPair(),
    generateForemanKeyPair(),
  ]);
  const description = await describeModule(queueModule());
  hashes = new Map(description.actions.map(action => [action.id, action.schemaHash]));
});

function env(): ForemanEnv {
  return {
    FOREMAN_APP_ID: APP_ID,
    FOREMAN_APP_KEY: appPair.privateKey,
    FOREMAN_READ_KEY: readPair.publicKey,
    FOREMAN_READ_KEY_NEXT: undefined,
    FOREMAN_EXECUTE_KEY: executePair.publicKey,
    FOREMAN_EXECUTE_KEY_NEXT: undefined,
    FOREMAN_WRITES: 'on',
  };
}

function memoryNonces(): NonceStore {
  const seen = new Set<string>();
  return {
    setIfNotExists: (key: string) => {
      if (seen.has(key)) return Promise.resolve(false);
      seen.add(key);
      return Promise.resolve(true);
    },
  };
}

function appOptions(clock: MockClock): ForemanAppOptions<Ctx> {
  return {
    env: env(),
    environment: ENVIRONMENT,
    app: { version: '1.2.3' },
    nonces: memoryNonces(),
    receipts: kvReceiptStore(memoryKv(clock), { namespace: `${APP_ID}:${ENVIRONMENT}` }),
    clock,
    health: () => ({ status: 'ok', checks: [] }),
    modules: [queueModule()],
    context: () => ({ tenant: 'acme' }),
  };
}

function clientFor(fetch: (request: Request) => Promise<Response>) {
  return createForemanClient({
    target: { aud: `${APP_ID}:${ENVIRONMENT}`, baseUrl: BASE_URL, appKey: appPair.publicKey },
    readKey: readPair.privateKey,
    executeKey: executePair.privateKey,
    clock: new MockClock(T0),
    fetch: async (input, init) => fetch(new Request(input, init)),
  });
}

function execute(client: ReturnType<typeof clientFor>, actionId: string, executionId: string) {
  return client.execute(
    actionId,
    { jobId: 'job_9' },
    {
      scopes: SCOPES,
      permit: {
        executionId,
        expectedRevision: 'rev_3',
        approvedBy: 'usr_alex',
        schemaHash: hashes.get(actionId) ?? '',
      },
    },
  );
}

/** The `admin.action.execute` spans, oldest first. */
function executeSpans(spans: SpanCapture) {
  return spans.finished.filter(span => span.name === 'admin.action.execute');
}

describe('admin.action.execute', () => {
  let spans: SpanCapture;
  beforeAll(() => {
    spans = captureSpans();
  });
  beforeEach(() => {
    spans.reset();
  });
  afterAll(() => {
    spans[Symbol.dispose]();
  });

  it('spans an applied execute with its action and receipt, and nothing private', async () => {
    const client = clientFor(createForemanHandlerFromEnv(appOptions(new MockClock(T0))));

    expect(orThrow(await execute(client, 'queue.retryJob', 'exe_applied'))).toEqual({ requeued: true });

    const span = spans.named('admin.action.execute');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    // Exactly these keys: no execution id, approver, job id, result or key reaches the span.
    expect(span.attributes).toEqual({ 'admin.action': 'queue.retryJob', 'admin.receipt': 'applied' });
    const collected = await spans.collectMetrics();
    const counter = collected.find(metric => metric.descriptor.name === 'admin.executions');
    expect(counter?.dataPoints).toEqual([
      expect.objectContaining({
        value: 1,
        attributes: { action: 'queue.retryJob', receipt: 'applied', outcome: 'success' },
      }),
    ]);
  });

  it('marks a returned action failure with failure.code and a failed receipt', async () => {
    const client = clientFor(createForemanHandlerFromEnv(appOptions(new MockClock(T0))));

    // Foreman sees a refusal on the wire; the app's span keeps the action's own code.
    expect(await execute(client, 'queue.dropJob', 'exe_refused')).toMatchObject({ code: 'admin.module_refused' });

    const span = spans.named('admin.action.execute');
    // WHY: a 409 is an answer the operator acts on, not a fault; error status would page on refusals.
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).toEqual({
      'admin.action': 'queue.dropJob',
      'admin.receipt': 'failed',
      'failure.code': 'admin.test_job_changed',
    });
  });

  it('sets error status for a returned fault (5xx), keeping failure.code', async () => {
    // WHY: a 5xx means the app or a dependency is broken; alerts on span errors must fire for it.
    const result = await observeExecute('queue.retryJob', () => Promise.resolve(StoreDown()));

    expect(result).toMatchObject({ code: 'admin.test_store_down' });
    const span = spans.named('admin.action.execute');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['failure.code']).toBe('admin.test_store_down');
  });

  it('marks a repeated execution id as replayed: the action ran once, the second answer came from its receipt', async () => {
    const client = clientFor(createForemanHandlerFromEnv(appOptions(new MockClock(T0))));

    orThrow(await execute(client, 'queue.retryJob', 'exe_twice'));
    orThrow(await execute(client, 'queue.retryJob', 'exe_twice'));

    expect(executeSpans(spans).map(span => span.attributes['admin.receipt'])).toEqual(['applied', 'replayed']);
  });

  it('nests under the http.request span when the foreman() Dot slice serves the execute', async () => {
    // WHY: through `foreman()` the execute arrives as a request. Its span must sit under that
    // request's span, or the action shows up in a trace no request points to.
    const engine = buildEngine([foreman(() => appOptions(new MockClock(T0))).resolve({})]);
    const client = clientFor(request => engine.fetch(request));

    orThrow(await execute(client, 'queue.retryJob', 'exe_dot'));

    expect(spans.named('admin.action.execute').parent?.name).toBe('http.request');
  });
});
