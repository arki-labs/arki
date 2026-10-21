/**
 * `startServer()` is the process's front door. A boot failure must answer
 * 503 without telling the caller why (the cause can name hosts or secrets).
 * Built client files must be served with the right cache: hashed `/assets/`
 * forever, everything else briefly. A `%2F` probe must be a 404, not a 500.
 * The context Start sees must be the one the app built for this request.
 * A hot update must dispose the old app before the new one opens the same
 * resources. With `eager`, a production server boots before its first
 * request, so a boot failure shows at process start.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { defineApp, plugin } from '@arki/dot';

import { makeAuthn, makeGateway } from './__fixtures__/start-app';
import { tanstackStart } from './dot';
import { startServer } from './start-server';

function makeApp(extra = plugin({ name: 'extra' })) {
  const { authn, calls } = makeAuthn();
  const { gateway } = makeGateway();
  const start = tanstackStart({
    needs: { rpc: gateway.provides.api, auth: authn.provides.auth },
    session: ({ auth }, request) => auth.principal(request.headers),
    rpc: ({ rpc }, request) => rpc.client(request.headers),
  });
  return { app: defineApp('shop').use(authn).use(gateway).use(extra).entrypoints(start), calls };
}

const page = (user = 'ada') => new Request('https://shop.example/digest', { headers: { 'x-user': user } });
const ok = () => new Response('page');

describe('startServer() boot failure', () => {
  it('answers 503 and keeps the cause out of the body', async () => {
    const broken = plugin({
      name: 'extra',
      boot() {
        throw new Error('cannot reach postgres://admin:hunter2@db');
      },
    });
    let handled = 0;
    const server = startServer(makeApp(broken).app, {
      handler: () => {
        handled += 1;
        return ok();
      },
    });

    const response = await server.fetch(page());
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).not.toContain('hunter2');
    expect(JSON.parse(body)).toEqual({ error: 'Service temporarily unavailable' });
    expect(handled).toBe(0);
  });
});

describe('startServer() context', () => {
  it('passes the request context to the Start handler', async () => {
    const seen: unknown[] = [];
    const { app } = makeApp();
    const server = startServer(app, {
      handler: async (_request, { context }) => {
        seen.push({
          keys: new Set(Object.keys(context)),
          rpc: context.rpc,
          session: await context.session(),
          hasRpcService: typeof context.services.api.handle === 'function',
          requestId: typeof context.requestId,
        });
        return ok();
      },
    });

    const request = page('ada');
    const response = await server.fetch(request);
    expect(await response.text()).toBe('page');
    expect(seen).toEqual([
      {
        keys: new Set(['services', 'rpc', 'session', 'requestId', 'signal']),
        rpc: { caller: 'ada' },
        session: { user: { id: 'ada' } },
        hasRpcService: true,
        requestId: 'string',
      },
    ]);
  });

  it('memoizes the session within a request only', async () => {
    const { app, calls } = makeApp();
    const server = startServer(app, {
      handler: async (_request, { context }) => {
        await context.session();
        await context.session();
        return ok();
      },
    });
    await server.fetch(page('ada'));
    await server.fetch(page('bob'));
    expect(calls.principal).toBe(2);
  });

  it('hands Start the request signal', async () => {
    const signals: AbortSignal[] = [];
    const server = startServer(makeApp().app, {
      handler: (_request, { context }) => {
        signals.push(context.signal);
        return ok();
      },
    });
    const request = page();
    await server.fetch(request);
    expect(signals[0]).toBe(request.signal);
  });
});

describe('startServer() client files', () => {
  let dir = '';
  let client = new URL('file:///');

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'start-client-'));
    await mkdir(path.join(dir, 'assets'));
    await writeFile(path.join(dir, 'assets', 'app-1a2b.js'), 'export {};');
    await writeFile(path.join(dir, 'favicon.ico'), 'icon');
    client = pathToFileURL(`${dir}/`);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function serve() {
    let handled = 0;
    const server = startServer(makeApp().app, {
      client,
      handler: () => {
        handled += 1;
        return ok();
      },
    });
    return { server, handled: () => handled };
  }

  it('caches hashed files under /assets/ forever', async () => {
    const { server, handled } = serve();
    const response = await server.fetch(new Request('https://shop.example/assets/app-1a2b.js'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
    expect(await response.text()).toBe('export {};');
    expect(handled()).toBe(0);
  });

  it('caches other files for an hour, since they keep their names across deploys', async () => {
    const { server } = serve();
    const response = await server.fetch(new Request('https://shop.example/favicon.ico'));
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('answers 404 to an encoded-slash probe instead of crashing', async () => {
    const { server, handled } = serve();
    const response = await server.fetch(new Request('https://shop.example/assets/..%2F..%2Fetc%2Fpasswd.js'));
    expect(response.status).toBe(404);
    expect(handled()).toBe(0);
  });

  it('falls through to Start for a missing file and for page paths', async () => {
    const { server, handled } = serve();
    await server.fetch(new Request('https://shop.example/assets/missing.js'));
    await server.fetch(page());
    expect(handled()).toBe(2);
  });
});

/** A plugin that records when the app starts. */
const booting = (events: string[]) =>
  plugin({
    name: 'extra',
    start() {
      events.push('start');
    },
  });

describe('startServer() eager', () => {
  it('boots the app before the first request when eager', async () => {
    const events: string[] = [];
    startServer(makeApp(booting(events)).app, { eager: true, handler: ok });
    await vi.waitFor(() => expect(events).toEqual(['start']));
  });

  it('waits for the first request otherwise', async () => {
    const events: string[] = [];
    const server = startServer(makeApp(booting(events)).app, { handler: ok });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(events).toEqual([]);
    await server.fetch(page());
    expect(events).toEqual(['start']);
  });
});

describe('startServer() hot replace', () => {
  it('disposes the old app before the new one starts', async () => {
    const events: string[] = [];
    const lifecycle = (label: string) =>
      plugin({
        name: 'extra',
        start() {
          events.push(`start:${label}`);
        },
        async dispose() {
          await new Promise(resolve => setTimeout(resolve, 20));
          events.push(`dispose:${label}`);
        },
      });
    const data: Record<string, unknown> = {};
    const disposers: ((data: Record<string, unknown>) => void)[] = [];
    const hot = {
      data,
      dispose: (callback: (data: Record<string, unknown>) => void) => {
        disposers.push(callback);
      },
    };

    const first = startServer(makeApp(lifecycle('a')).app, {
      hot,
      handler: ok,
    });
    await first.fetch(page());
    for (const dispose of disposers) dispose(data);

    const second = startServer(makeApp(lifecycle('b')).app, { hot, handler: ok });
    const response = await second.fetch(page());

    expect(response.status).toBe(200);
    expect(events).toEqual(['start:a', 'dispose:a', 'start:b']);
    const stale = await first.fetch(page());
    expect(stale.status).toBe(503);
  });
});
