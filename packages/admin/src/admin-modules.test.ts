/**
 * T(admin-modules) — the same module set, mounted through the DOT adapter
 * (`foreman()` + `@arki/http`) and through the plain handler
 * (`createForemanHandlerFromEnv`), must load identical contracts and give
 * identical read results. If the DOT attachment altered a path, dropped a
 * body or described a different module list, a byte comparison here fails.
 */
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import type { FeatureSlice } from '@arki/dot/feature';
import { MockClock } from '@arki/clock';
import { z } from '@arki/contracts';
import { orThrow } from '@arki/failure';
import { defineFeature } from '@arki/dot/feature';
import { buildEngine } from '@arki/http';

import type { FleetHealth } from './contract';
import type { NonceStore } from './dispatcher';
import type { ForemanEnv } from './env';
import type { ForemanAppOptions } from './foreman-app';
import type { JsonValue } from './module';
import { createForemanClient, generateForemanKeyPair } from './client';
import { foreman } from './dot';
import { foremanConfigFromEnv } from './env';
import { createForemanHandlerFromEnv } from './foreman-app';
import { ADMIN_ERROR_CODES, defineAction, defineModule, defineRead, describeModule } from './module';
import { kvReceiptStore } from './receipts';
import { memoryKv, refusal } from './test-support';

type KeyPair = Awaited<ReturnType<typeof generateForemanKeyPair>>;

const APP_ID = 'novelette';
const ENVIRONMENT = 'prod';
const BASE_URL = 'https://novelette.test';
const T0 = new Date('2026-10-14T12:00:00Z');

const health: FleetHealth = {
  status: 'degraded',
  checks: [
    { name: 'database', ok: true },
    { name: 'queue', ok: false, detail: '3 jobs failed' },
  ],
};

let readPair: KeyPair;
let executePair: KeyPair;
let appPair: KeyPair;
let retryHash: string;

function queueModule() {
  return defineModule({
    id: '@arki/queue',
    version: '1.0.0',
    reads: {
      failedJobs: defineRead({
        id: 'queue.failedJobs',
        summary: 'Failed jobs',
        permission: 'queue:read',
        input: z.object({ limit: z.number().int().default(10) }),
        output: z.array(z.object({ id: z.string() })),
        load: async ({ limit }, ctx: { tenant: string }) => [{ id: `${ctx.tenant}_job_1` }].slice(0, limit),
      }),
    },
    actions: {
      retryJob: defineAction({
        id: 'queue.retryJob',
        summary: 'Retry one failed job',
        permission: 'queue:write',
        risk: 'low',
        input: z.object({ jobId: z.string().min(1) }),
        previewOutput: z.object({ revision: z.string(), jobId: z.string() }),
        output: z.object({ requeued: z.boolean() }),
        preview: async ({ jobId }, _ctx: { tenant: string }) => ({ revision: 'rev_3', jobId }),
        execute: async () => ({ requeued: true }),
      }),
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
  retryHash = description.actions.find(action => action.id === 'queue.retryJob')?.schemaHash ?? '';
});

function fullEnv(): ForemanEnv {
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

function memoryNonces(clock: MockClock): NonceStore {
  const expiries = new Map<string, number>();
  return {
    setIfNotExists: async (key, _value, expirationSeconds) => {
      const now = clock.now().getTime();
      const expiry = expiries.get(key);
      if (expiry !== undefined && expiry > now) return false;
      expiries.set(key, now + expirationSeconds * 1000);
      return true;
    },
  };
}

function appOptions(env: ForemanEnv, clock: MockClock): ForemanAppOptions<{ tenant: string }> {
  return {
    env,
    environment: ENVIRONMENT,
    app: { version: '1.2.3', commit: 'abc1234' },
    packages: { '@arki/queue': '0.2.0' },
    nonces: memoryNonces(clock),
    receipts: kvReceiptStore(memoryKv(clock), { namespace: 'novelette:prod' }),
    clock,
    health: () => health,
    modules: [queueModule()],
    context: () => ({ tenant: 'acme' }),
  };
}

type Mount = { name: string; fetch: (request: Request) => Promise<Response> };

/** The same options, attached the two supported ways. */
function mounts(env: ForemanEnv = fullEnv()): Mount[] {
  const clock = new MockClock(T0);
  const plain = createForemanHandlerFromEnv(appOptions(env, clock));
  const dot = buildEngine([foreman(() => appOptions(env, new MockClock(T0))).resolve({})]);
  return [
    { name: 'plain handler', fetch: plain },
    { name: 'DOT adapter', fetch: request => dot.fetch(request) },
  ];
}

function clientFor(mount: Mount) {
  return createForemanClient({
    target: { aud: `${APP_ID}:${ENVIRONMENT}`, baseUrl: BASE_URL, appKey: appPair.publicKey },
    readKey: readPair.privateKey,
    executeKey: executePair.privateKey,
    clock: new MockClock(T0),
    fetch: async (input, init) => mount.fetch(new Request(input, init)),
  });
}

async function observe(mount: Mount): Promise<Record<string, JsonValue>> {
  const client = clientFor(mount);
  const scopes = ['core:read', 'queue:*'];
  return {
    manifest: orThrow(await client.manifest()),
    viaRead: orThrow(await client.read('core.manifest.get', {}, scopes)),
    status: orThrow(await client.read('core.health.status', {}, scopes)),
    checks: orThrow(await client.read('core.health.checks', {}, scopes)),
    failed: orThrow(await client.read('queue.failedJobs', { limit: 5 }, scopes)),
    preview: orThrow(await client.preview('queue.retryJob', { jobId: 'job_9' }, scopes)),
    executed: orThrow(
      await client.execute(
        'queue.retryJob',
        { jobId: 'job_9' },
        {
          scopes,
          permit: { executionId: 'exe_1', expectedRevision: 'rev_3', approvedBy: 'usr_alex', schemaHash: retryHash },
        },
      ),
    ),
  };
}

describe('T(admin-modules): one module set, two attachments', () => {
  it('serves byte-identical manifests and identical read, preview and execute results', async () => {
    const [plain, dot] = mounts();
    if (plain === undefined || dot === undefined) throw new Error('expected two mounts');
    const [fromPlain, fromDot] = [await observe(plain), await observe(dot)];
    expect(JSON.stringify(fromDot)).toBe(JSON.stringify(fromPlain));
    expect(fromPlain['executed']).toEqual({ requeued: true });
  });

  it('describes core.health, core.manifest, core.receipts (a store is given) and the app modules, in that order', async () => {
    const [plain] = mounts();
    if (plain === undefined) throw new Error('expected a mount');
    const manifest = orThrow(await clientFor(plain).manifest());
    expect(manifest.modules.map(module => module.id)).toEqual([
      'core.health',
      'core.manifest',
      'core.receipts',
      '@arki/queue',
    ]);
    expect(manifest.app).toEqual({ id: APP_ID, environment: ENVIRONMENT, version: '1.2.3', commit: 'abc1234' });
    expect(manifest.readiness.writes).toBe('on');
  });

  it('core.manifest.get returns exactly what GET /api/foreman/manifest serves', async () => {
    for (const mount of mounts()) {
      const client = clientFor(mount);
      expect(await client.read('core.manifest.get', {}, ['core:read']), mount.name).toEqual(await client.manifest());
    }
  });

  it('core.health reports the v1 fleet health shape, so v1 and v2 agree', async () => {
    for (const mount of mounts()) {
      const client = clientFor(mount);
      expect(await client.read('core.health.status', {}, ['core:read']), mount.name).toEqual({ status: health.status });
      expect(await client.read('core.health.checks', {}, ['core:read']), mount.name).toEqual(health.checks);
    }
  });

  it('rejects a read signed without the core:read scope on both attachments', async () => {
    for (const mount of mounts()) {
      const error = await refusal(clientFor(mount).read('core.health.status', {}, ['queue:read']));
      expect(error.code, mount.name).toBe(ADMIN_ERROR_CODES.scopeDenied);
    }
  });
});

describe('Foreman v2 is off until keys are set', () => {
  const empty: ForemanEnv = {
    FOREMAN_APP_ID: undefined,
    FOREMAN_APP_KEY: undefined,
    FOREMAN_READ_KEY: undefined,
    FOREMAN_READ_KEY_NEXT: undefined,
    FOREMAN_EXECUTE_KEY: undefined,
    FOREMAN_EXECUTE_KEY_NEXT: undefined,
    FOREMAN_WRITES: undefined,
  };

  it('boots and answers 404 on both attachments when no FOREMAN_* variable is set', async () => {
    for (const mount of mounts(empty)) {
      const response = await mount.fetch(new Request(`${BASE_URL}/api/foreman/manifest`));
      expect(response.status, mount.name).toBe(404);
    }
  });

  it('fails loud when only some variables are set, so a typo cannot half-enable it', () => {
    expect(() => foremanConfigFromEnv({ ...empty, FOREMAN_APP_ID: APP_ID }, ENVIRONMENT)).toThrow(
      expect.objectContaining({
        code: ADMIN_ERROR_CODES.invalidConfig,
        message: expect.stringMatching(/Missing: FOREMAN_APP_KEY, FOREMAN_READ_KEY, FOREMAN_EXECUTE_KEY/),
      }),
    );
  });

  it('refuses every execute unless FOREMAN_WRITES=on', () => {
    expect(foremanConfigFromEnv({ ...fullEnv(), FOREMAN_WRITES: undefined }, ENVIRONMENT)?.writes).toBe('off');
  });
});

describe('the foreman() slice in a feature', () => {
  it('is a feature slice under the routes key, with the four routes in its manifest actions', () => {
    const slice = foreman(() => appOptions(fullEnv(), new MockClock(T0)));
    expectTypeOf(slice).toExtend<FeatureSlice<'routes', unknown, never>>();
    expect(slice.actions.map(action => action.id)).toEqual([
      'foreman.manifest',
      'foreman.read',
      'foreman.preview',
      'foreman.execute',
    ]);
    const operations = defineFeature('operations').entrypoints({ kind: 'routes', ...slice });
    expect(operations.entrypoints).toHaveLength(1);
  });
});
