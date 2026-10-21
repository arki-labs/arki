/**
 * The mounts carry the HTTP habits callers rely on. CORS must reflect only
 * the origins the app listed (plus extensions when asked), because the rpc
 * mount allows credentials: reflecting any origin would let any site call
 * it as the signed-in user. Preflights answer 204. A path no procedure
 * matches is a 404, and a crash is a 500 that does not leak its message.
 * The cron mount must refuse a call without the right secret. Every mount
 * serves through the plugin's own needs, never an assumed service key: the
 * fixture gateway is published as `api`.
 */
import { os } from '@orpc/server';
import { describe, expect, it } from 'vitest';

import type { CronContext } from '@arki/schedule/orpc';
import { defineApp, plugin } from '@arki/dot';
import { isFailure } from '@arki/failure';

import { makeAuthn, makeGateway } from './__fixtures__/start-app';
import { tanstackStart } from './dot';
import { authHandlers, cronHandlers, healthHandlers, rpcHandlers } from './mounts';

const triggered: string[] = [];
const timers = plugin({
  name: 'timers',
  provides: {
    timers: () => ({
      trigger: async (name: string) => {
        triggered.push(name);
        return { name, status: 'ran' as const, value: undefined };
      },
    }),
  },
});

const cronRouter = {
  'send-digest': os.$context<CronContext>().handler(async ({ context }) => {
    await context.schedules.trigger('send-digest');
    return { sent: true };
  }),
};

async function startedApp(options: { readonly extensions?: boolean } = {}) {
  const { authn, calls } = makeAuthn();
  const { gateway } = makeGateway();
  const start = tanstackStart({
    needs: { api: gateway.provides.api, auth: authn.provides.auth, timers: timers.provides.timers },
    session: () => null,
    rpc: () => null,
    mounts: {
      rpc: { at: '/api/orpc', serve: ({ api }, request, prefix) => api.handle(request, prefix) },
      auth: { at: '/api/auth', serve: ({ auth }, request) => auth.handler(request) },
      cron: { at: '/api/cron', router: cronRouter, secret: 'cron-secret', schedules: ({ timers }) => timers },
      health: { at: '/api/health' },
    },
    cors: { origins: ['https://shop.example'], extensions: options.extensions ?? false },
  });
  const app = await defineApp('shop').use(authn).use(gateway).use(timers).entrypoints(start).start();
  if (isFailure(app)) throw new Error(`app did not start: ${app.code}`);
  return { context: { services: app.services }, calls, dispose: () => app.dispose() };
}

/** An app that declares no mount at all. */
async function bareApp() {
  const { gateway } = makeGateway();
  const start = tanstackStart({ needs: { api: gateway.provides.api }, session: () => null, rpc: () => null });
  const app = await defineApp('bare').use(gateway).entrypoints(start).start();
  if (isFailure(app)) throw new Error(`app did not start: ${app.code}`);
  return { context: { services: app.services }, dispose: () => app.dispose() };
}

const rpcRequest = (path: string, init: RequestInit = {}) => new Request(`https://api.example/api/orpc${path}`, init);
const cronRequest = (name: string, authorization?: string) =>
  new Request(`https://api.example/api/cron/${name}`, {
    method: 'POST',
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });

describe('rpcHandlers()', () => {
  const handlers = rpcHandlers();

  it('serves the gateway the plugin needs, at the declared path, whatever its service key', async () => {
    const { context, dispose } = await startedApp();
    const response = await handlers.POST({ request: rpcRequest('/ping', { method: 'POST' }), context });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pong: true });
    await dispose();
  });

  it('reflects a listed origin with credentials', async () => {
    const { context, dispose } = await startedApp();
    const request = rpcRequest('/ping', { method: 'POST', headers: { origin: 'https://shop.example' } });
    const response = await handlers.POST({ request, context });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.example');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(response.headers.get('Vary')).toContain('Origin');
    await dispose();
  });

  it('never reflects an unlisted origin', async () => {
    const { context, dispose } = await startedApp({ extensions: true });
    const request = rpcRequest('/ping', { method: 'POST', headers: { origin: 'https://evil.example' } });
    const response = await handlers.POST({ request, context });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    await dispose();
  });

  it('reflects extension origins only when extensions are on', async () => {
    const headers = { origin: 'chrome-extension://abcdef' };
    const on = await startedApp({ extensions: true });
    const off = await startedApp({ extensions: false });
    const allowed = await handlers.POST({ request: rpcRequest('/ping', { method: 'POST', headers }), context: on.context });
    const refused = await handlers.POST({ request: rpcRequest('/ping', { method: 'POST', headers }), context: off.context });
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('chrome-extension://abcdef');
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBeNull();
    await on.dispose();
    await off.dispose();
  });

  it('answers a preflight with 204 and the CORS headers', async () => {
    const { context, dispose } = await startedApp();
    const request = rpcRequest('/ping', { method: 'OPTIONS', headers: { origin: 'https://shop.example' } });
    const response = handlers.OPTIONS({ request, context });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.example');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    await dispose();
  });

  it('answers 404 when no procedure matched', async () => {
    const { context, dispose } = await startedApp();
    const response = await handlers.POST({ request: rpcRequest('/nope', { method: 'POST' }), context });
    expect(response.status).toBe(404);
    await dispose();
  });

  it('answers 500 on a crash without leaking its message', async () => {
    const { context, dispose } = await startedApp();
    const response = await handlers.POST({ request: rpcRequest('/boom', { method: 'POST' }), context });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('password');
    await dispose();
  });
});

describe('cronHandlers()', () => {
  const handlers = cronHandlers();

  it('refuses a call without the right bearer secret, before any schedule runs', async () => {
    const { context, dispose } = await startedApp();
    triggered.length = 0;
    const missing = await handlers.POST({ request: cronRequest('send-digest'), context });
    const wrongScheme = await handlers.POST({ request: cronRequest('send-digest', 'Basic x'), context });
    const wrong = await handlers.POST({ request: cronRequest('send-digest', 'Bearer nope'), context });
    expect([missing.status, wrongScheme.status, wrong.status]).toEqual([401, 401, 401]);
    expect(await wrong.json()).toEqual({ error: 'Invalid cron secret' });
    expect(triggered).toEqual([]);
    await dispose();
  });

  it('triggers the named schedule through the scheduler the plugin needs', async () => {
    const { context, dispose } = await startedApp();
    triggered.length = 0;
    const response = await handlers.POST({ request: cronRequest('send-digest', 'Bearer cron-secret'), context });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true });
    expect(triggered).toEqual(['send-digest']);
    await dispose();
  });

  it('answers 404 for an unknown cron', async () => {
    const { context, dispose } = await startedApp();
    const response = await handlers.POST({ request: cronRequest('nope', 'Bearer cron-secret'), context });
    expect(response.status).toBe(404);
    await dispose();
  });
});

describe('authHandlers() and healthHandlers()', () => {
  it('forwards auth requests through the declared auth mount', async () => {
    const { context, calls, dispose } = await startedApp();
    const response = await authHandlers().GET({ request: new Request('https://api.example/api/auth/session'), context });
    expect(await response.json()).toEqual({ auth: '/api/auth/session' });
    expect(calls.handler).toBe(1);
    await dispose();
  });

  it('reports ok', async () => {
    const { context, dispose } = await startedApp();
    const response = healthHandlers().GET({ context });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    await dispose();
  });
});

describe('a handler for an undeclared mount', () => {
  // These calls do not compile (see request-context.test-d.ts); on an erased path the answer is a 404.
  it('answers 404 instead of serving anything', async () => {
    const { context, dispose } = await bareApp();
    const request = new Request('https://api.example/api/orpc/ping', { method: 'POST' });
    const responses = [
      // @ts-expect-error -- the bare app declares no rpc mount
      await rpcHandlers().POST({ request, context }),
      // @ts-expect-error -- the bare app declares no auth mount
      await authHandlers().POST({ request, context }),
      // @ts-expect-error -- the bare app declares no cron mount
      await cronHandlers().POST({ request: cronRequest('send-digest', 'Bearer cron-secret'), context }),
      // @ts-expect-error -- the bare app declares no health mount
      healthHandlers().GET({ context }),
    ];
    expect(responses.map(response => response.status)).toEqual([404, 404, 404, 404]);
    await dispose();
  });
});
