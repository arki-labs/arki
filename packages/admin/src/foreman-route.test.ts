/**
 * T(foreman-route) — the one mount every fleet app uses for `/api/foreman/*`. Why it matters: the keys
 * reach every app's Coolify env before its code is ready, so the mount must stay off (404) without them,
 * refuse to run signed requests without replay protection, and keep each app's receipts apart.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';

import type { ForemanEnv } from './env';
import type { ForemanStore } from './foreman-route';
import { createForemanClient, generateForemanKeyPair, signRequest } from './client';
import { createForemanRoute, memoryForemanStore } from './foreman-route';
import { defineAction, defineModule, describeModule } from './module';

type KeyPair = Awaited<ReturnType<typeof generateForemanKeyPair>>;

const APP_ID = 'ekuation';
const BASE_URL = 'https://ekuation.test';
const AUD = `${APP_ID}:prod`;

let readPair: KeyPair;
let executePair: KeyPair;
let appPair: KeyPair;

beforeAll(async () => {
  [readPair, executePair, appPair] = await Promise.all([
    generateForemanKeyPair(),
    generateForemanKeyPair(),
    generateForemanKeyPair(),
  ]);
});

function keyedEnv(): ForemanEnv & { NODE_ENV: string } {
  return {
    NODE_ENV: 'production',
    FOREMAN_APP_ID: APP_ID,
    FOREMAN_APP_KEY: appPair.privateKey,
    FOREMAN_READ_KEY: readPair.publicKey,
    FOREMAN_EXECUTE_KEY: executePair.publicKey,
    FOREMAN_WRITES: 'on',
  };
}

const bareEnv = { NODE_ENV: 'production' };

function appModule() {
  return defineModule({
    id: 'ekuation',
    version: '1.0.0',
    reads: {},
    actions: {
      clearCache: defineAction({
        id: 'ekuation.clearCache',
        summary: 'Clear the formula cache',
        permission: 'ekuation:write',
        risk: 'low',
        input: z.object({}),
        previewOutput: z.object({ revision: z.string() }),
        output: z.object({ cleared: z.boolean() }),
        preview: () => Promise.resolve({ revision: 'rev_1' }),
        execute: () => Promise.resolve({ cleared: true }),
      }),
    },
  });
}

/** A store that records every key written, so a test can see where receipts went. */
function recordingStore() {
  const inner = memoryForemanStore();
  const keys: string[] = [];
  const store: ForemanStore = {
    get: key => inner.get(key),
    set: (key, value, ttl) => {
      keys.push(key);
      return inner.set(key, value, ttl);
    },
    setIfNotExists: (key, value, ttl) => {
      keys.push(key);
      return inner.setIfNotExists(key, value, ttl);
    },
  };
  return { store, keys };
}

function clientFor(route: (request: Request) => Promise<Response>) {
  return createForemanClient({
    target: { aud: AUD, baseUrl: BASE_URL, appKey: appPair.publicKey },
    readKey: readPair.privateKey,
    executeKey: executePair.privateKey,
    fetch: async (input, init) => route(new Request(input, init)),
  });
}

const health = () => ({ status: 'ok' as const, checks: [] });
const request = () => new Request(`${BASE_URL}/api/foreman/manifest`);

describe('T(foreman-route) createForemanRoute', () => {
  it('answers 404 while the keys are unset, with or without a store', async () => {
    for (const store of [null, memoryForemanStore()]) {
      const route = createForemanRoute(() => ({
        env: bareEnv,
        app: { version: '1.0.0' },
        store,
        health,
        context: () => ({}),
      }));
      const response = await route(new Request(`${BASE_URL}/api/foreman/manifest`));
      expect(response.status).toBe(404);
    }
  });

  it('throws ARKI_ADMIN_E014 once the keys are set but no store is passed', async () => {
    const route = createForemanRoute(() => ({
      env: keyedEnv(),
      app: { version: '1.0.0' },
      store: null,
      health,
      context: () => ({}),
    }));
    await expect(async () => route(new Request(`${BASE_URL}/api/foreman/manifest`))).rejects.toThrow(/ARKI_ADMIN_E014/);
  });

  it('serves a signed manifest for the env audience, with core.receipts from the one store', async () => {
    const route = createForemanRoute(() => ({
      env: keyedEnv(),
      app: { version: '2.0.0', commit: 'abc1234' },
      store: memoryForemanStore(),
      health,
      context: () => ({}),
    }));
    const manifest = await clientFor(request => route(request)).manifest();
    expect(manifest.app).toEqual({ id: APP_ID, environment: 'prod', version: '2.0.0', commit: 'abc1234' });
    expect(manifest.modules.map(module => module.id)).toEqual(['core.health', 'core.manifest', 'core.receipts']);
  });

  it('refuses a replayed request: the store holds the nonces', async () => {
    const route = createForemanRoute(() => ({
      env: keyedEnv(),
      app: { version: '1.0.0' },
      store: memoryForemanStore(),
      health,
      context: () => ({}),
    }));
    const signed = await signRequest({
      aud: AUD,
      method: 'GET',
      path: '/api/foreman/manifest',
      body: new Uint8Array(),
      scopes: ['core:read'],
      use: 'read',
      privateKey: readPair.privateKey,
    });
    const send = () => route(new Request(`${BASE_URL}/api/foreman/manifest`, { headers: signed.headers }));
    const first = await send();
    const replayed = await send();
    expect(first.status).toBe(200);
    expect(replayed.status).toBe(401);
  });

  it("keeps the receipt under the app audience, so apps sharing one store never read each other's", async () => {
    const { store, keys } = recordingStore();
    const route = createForemanRoute(() => ({
      env: keyedEnv(),
      app: { version: '1.0.0' },
      store,
      health,
      modules: [appModule()],
      context: () => ({}),
    }));
    const description = await describeModule(appModule());
    const schemaHash = description.actions[0]?.schemaHash ?? '';
    const executed = await clientFor(request => route(request)).execute(
      'ekuation.clearCache',
      {},
      {
        scopes: ['ekuation:*'],
        permit: { executionId: 'exe_1', expectedRevision: 'rev_1', approvedBy: 'usr_alex', schemaHash },
      },
    );
    expect(executed).toEqual({ cleared: true });
    const receiptKeys = keys.filter(key => key.includes('exe_1'));
    expect(receiptKeys.length).toBeGreaterThan(0);
    for (const key of receiptKeys) expect(key).toContain(AUD);
  });

  it('builds once per services object, and once in all for an app without one', async () => {
    let builds = 0;
    const perGraph = createForemanRoute((services: { name: string }) => {
      builds += 1;
      return { env: bareEnv, app: { version: services.name }, store: null, health, context: () => ({}) };
    });
    const first = { name: '1.0.0' };
    const second = { name: '2.0.0' };
    await perGraph(request(), first);
    await perGraph(request(), first);
    await perGraph(request(), second);
    expect(builds).toBe(2);

    let plainBuilds = 0;
    const plain = createForemanRoute(() => {
      plainBuilds += 1;
      return { env: bareEnv, app: { version: '1.0.0' }, store: null, health, context: () => ({}) };
    });
    expect(plainBuilds).toBe(0);
    await plain(request());
    await plain(request());
    expect(plainBuilds).toBe(1);
  });
});

describe('T(foreman-route) memoryForemanStore', () => {
  it('takes a nonce once until it expires, then again', async () => {
    let now = 0;
    const store = memoryForemanStore(() => now);
    expect(await store.setIfNotExists('n1', 1, 60)).toBe(true);
    expect(await store.setIfNotExists('n1', 1, 60)).toBe(false);
    now = 60_000;
    expect(await store.setIfNotExists('n1', 1, 60)).toBe(true);
  });

  it('forgets a receipt after its TTL', async () => {
    let now = 0;
    const store = memoryForemanStore(() => now);
    const receipt = {
      status: 'pending',
      executionId: 'exe_1',
      actionId: 'a.b',
      claimedAt: '2026-10-23T00:00:00.000Z',
    } as const;
    await store.set('r1', receipt, 10);
    expect(await store.get('r1')).toEqual(receipt);
    now = 10_000;
    expect(await store.get('r1')).toBeUndefined();
  });
});
