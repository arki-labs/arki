/**
 * `tanstackStart()` builds each request's context from its needs. The
 * session must be read lazily and at most once per request (it is a
 * database round trip), and never leak into another request. Each mount's
 * path is declared once, in the plugin, and the manifest must follow it so
 * `dot explain` shows where the app really listens.
 */
import { describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot';
import { DotPluginError } from '@arki/dot/plugin';
import { isFailure, UnexpectedDefect } from '@arki/failure';

import { makeAuthn, makeGateway } from './__fixtures__/start-app';
import { TANSTACK_START_PLUGIN_ERROR_CODES, tanstackStart } from './dot';

type AppOptions = {
  readonly cors?: { origins: string[]; extensions?: boolean };
  readonly rpcAt?: `/${string}`;
  readonly authAt?: `/${string}`;
  readonly secret?: () => string;
};

const schedules = { trigger: async (name: string) => ({ name, status: 'ran' as const, value: undefined }) };

function makeApp(options: AppOptions = {}) {
  const { authn, calls } = makeAuthn();
  const { gateway } = makeGateway();
  const start = tanstackStart({
    needs: { api: gateway.provides.api, auth: authn.provides.auth },
    session: ({ auth }, request) => auth.principal(request.headers),
    rpc: ({ api }, request) => api.client(request.headers),
    mounts: {
      rpc: { at: options.rpcAt ?? '/api/orpc', serve: ({ api }, request, prefix) => api.handle(request, prefix) },
      auth: { at: options.authAt ?? '/api/auth', serve: ({ auth }, request) => auth.handler(request) },
      cron: { at: '/api/cron', router: {}, secret: options.secret ?? (() => 'cron-secret'), schedules: () => schedules },
      health: { at: '/api/health' },
    },
    ...(options.cors === undefined ? {} : { cors: () => options.cors ?? { origins: [] } }),
  });
  return { app: defineApp('shop').use(authn).use(gateway).entrypoints(start), calls };
}

async function started(app: ReturnType<typeof makeApp>['app']) {
  const running = await app.start();
  if (isFailure(running)) throw new Error(`app did not start: ${running.code}`);
  return running;
}

const request = (user: string) => new Request('https://shop.example/', { headers: { 'x-user': user } });

describe('tanstackStart() context', () => {
  it('builds a fresh context per request, bound to that request', async () => {
    const running = await started(makeApp().app);
    const signal = new AbortController().signal;
    const ada = await running.services.tanstackStart.context(request('ada'), signal);
    const bob = await running.services.tanstackStart.context(request('bob'), signal);

    expect(ada.rpc).toEqual({ caller: 'ada' });
    expect(bob.rpc).toEqual({ caller: 'bob' });
    expect(ada.requestId).not.toBe(bob.requestId);
    expect(ada.signal).toBe(signal);
    await running.dispose();
  });

  it('reads the session only when asked, once per request, never shared across requests', async () => {
    const { app, calls } = makeApp();
    const running = await started(app);
    const signal = new AbortController().signal;
    const ada = await running.services.tanstackStart.context(request('ada'), signal);
    expect(calls.principal).toBe(0);

    const [first, second] = await Promise.all([ada.session(), ada.session()]);
    expect(first).toEqual({ user: { id: 'ada' } });
    expect(second).toBe(first);
    expect(calls.principal).toBe(1);

    const bob = await running.services.tanstackStart.context(request('bob'), signal);
    expect(await bob.session()).toEqual({ user: { id: 'bob' } });
    expect(calls.principal).toBe(2);
    await running.dispose();
  });
});

describe('tanstackStart() manifest', () => {
  const mountsOf = (options: AppOptions) => {
    const configured = makeApp(options).app.configure();
    if (isFailure(configured)) throw new Error(`configure failed: ${configured.code}`);
    return configured.manifest.actions
      .filter(action => action.plugin === 'tanstack-start')
      .map(action => [action.id, action.binding, action.direction, action.address]);
  };

  it('declares one http action per declared mount, at the path the plugin was given', () => {
    expect(mountsOf({ rpcAt: '/rpc/v2', authAt: '/auth' })).toEqual([
      ['tanstack-start.rpc', 'http', 'in', '/rpc/v2/*'],
      ['tanstack-start.auth', 'http', 'in', '/auth/*'],
      ['tanstack-start.cron', 'http', 'in', '/api/cron/*'],
      ['tanstack-start.health', 'http', 'in', '/api/health'],
    ]);
  });

  it('declares no mount action when no mount is declared', () => {
    const { gateway } = makeGateway();
    const start = tanstackStart({ needs: { api: gateway.provides.api }, session: () => null, rpc: () => null });
    const configured = defineApp('bare').use(gateway).entrypoints(start).configure();
    if (isFailure(configured)) throw new Error('configure failed');
    expect(configured.manifest.actions.filter(action => action.plugin === 'tanstack-start')).toEqual([]);
  });
});

/** The coded error a boot stopped on, or a test failure when the boot did not stop that way. */
async function bootError(app: ReturnType<typeof makeApp>['app']) {
  const caught = await app.start();
  if (!UnexpectedDefect.is(caught)) throw new Error('boot should stop on a defect');
  if (!(caught.cause instanceof DotPluginError)) throw new Error('the defect should carry a DotPluginError');
  return caught.cause;
}

describe('tanstackStart() configure', () => {
  it('never reads the env-backed options, so `vite build` runs without the server env', () => {
    const unread = () => {
      throw new Error('read during configure');
    };
    const { app } = makeApp({ secret: unread, cors: undefined });
    expect(isFailure(app.configure())).toBe(false);
  });

  it('rejects two mounts at one path, since one route file would shadow the other', () => {
    expect(isFailure(makeApp({ rpcAt: '/api/x', authAt: '/api/x' }).app.configure())).toBe(true);
  });

  it('rejects a mount path with a trailing slash, which would mount at a double slash', () => {
    expect(isFailure(makeApp({ rpcAt: '/api/rpc/' }).app.configure())).toBe(true);
  });

});

describe('tanstackStart() boot', () => {
  it('stops on an empty cron secret, which would let anyone trigger schedules', async () => {
    const error = await bootError(makeApp({ secret: () => '' }).app);
    expect(error.code).toBe(TANSTACK_START_PLUGIN_ERROR_CODES.cronSecretInvalid);
    expect(error.message).toMatch(/cron secret/);
  });

  it('stops on a CORS origin with a path, so a typo cannot silently block every caller', async () => {
    const error = await bootError(makeApp({ cors: { origins: ['https://shop.example/'] } }).app);
    expect(error.code).toBe(TANSTACK_START_PLUGIN_ERROR_CODES.corsInvalid);
  });

  it('accepts listed origins and resolves the policy', async () => {
    const running = await started(makeApp({ cors: { origins: ['https://shop.example'], extensions: true } }).app);
    const { cors } = running.services.tanstackStart;
    expect(cors.allows('https://shop.example')).toBe(true);
    expect(cors.allows('https://evil.example')).toBe(false);
    expect(cors.allows('chrome-extension://abcdef')).toBe(true);
    expect(cors.allows(null)).toBe(false);
    await running.dispose();
  });
});
