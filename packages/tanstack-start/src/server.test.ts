import { resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerHandler, setupGracefulShutdown } from './server';

type ServeOptions = {
  port: number;
  hostname: string;
  development: boolean;
  fetch: (request: Request) => Promise<Response>;
};

/** Stands in for a BunFile: a Blob that knows whether it "exists". */
class StubFile extends Blob {
  readonly present: boolean;

  constructor(present: boolean) {
    super(['file-body']);
    this.present = present;
  }

  exists(): Promise<boolean> {
    return Promise.resolve(this.present);
  }
}

const staticDirectory = './dist/client';
let served: ServeOptions | undefined;
let existingFiles: Set<string>;
let requestedPaths: string[];
let stopMock: ReturnType<typeof vi.fn>;

function fetchHandler(): ServeOptions['fetch'] {
  if (!served) throw new Error('createServerHandler did not call Bun.serve');
  return served.fetch;
}

beforeEach(() => {
  served = undefined;
  existingFiles = new Set();
  requestedPaths = [];
  stopMock = vi.fn();
  vi.stubGlobal('Bun', {
    serve(options: ServeOptions) {
      served = options;
      return { stop: stopMock };
    },
    file(path: string) {
      requestedPaths.push(path);
      return new StubFile(existingFiles.has(path));
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createServerHandler: config', () => {
  it('binds to all interfaces on port 3000 by default', () => {
    vi.stubEnv('PORT', '');
    createServerHandler({}, () => new Response('app'));

    expect(served?.port).toBe(3000);
    expect(served?.hostname).toBe('0.0.0.0');
  });

  it('reads the port from PORT and lets the config override everything', () => {
    vi.stubEnv('PORT', '4123');
    createServerHandler({}, () => new Response('app'));
    expect(served?.port).toBe(4123);

    createServerHandler({ port: 8080, hostname: '127.0.0.1', development: true }, () => new Response('app'));
    expect(served?.port).toBe(8080);
    expect(served?.hostname).toBe('127.0.0.1');
    expect(served?.development).toBe(true);
  });
});

describe('createServerHandler: static files', () => {
  it('serves an existing file under /assets with a one year immutable cache header', async () => {
    existingFiles.add(`${staticDirectory}/assets/app.js`);
    const appHandler = vi.fn(() => new Response('app'));
    createServerHandler({}, appHandler);

    const response = await fetchHandler()(new Request('http://localhost/assets/app.js'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).toBe('file-body');
    expect(appHandler).not.toHaveBeenCalled();
  });

  it('honours a custom directory and prefix', async () => {
    existingFiles.add('./public/static/logo.svg');
    const appHandler = vi.fn(() => new Response('app'));
    createServerHandler({ static: { directory: './public', prefix: '/static' } }, appHandler);

    const response = await fetchHandler()(new Request('http://localhost/static/logo.svg'));

    expect(response.status).toBe(200);
    expect(appHandler).not.toHaveBeenCalled();
  });

  it('hands a missing static file to the app instead of answering 404 itself', async () => {
    const appHandler = vi.fn(() => new Response('spa shell', { status: 200 }));
    createServerHandler({}, appHandler);

    const response = await fetchHandler()(new Request('http://localhost/assets/missing.js'));

    expect(appHandler).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('spa shell');
  });

  it('does not touch the disk for paths outside the static prefix', async () => {
    const appHandler = vi.fn(() => new Response('page'));
    createServerHandler({}, appHandler);

    await fetchHandler()(new Request('http://localhost/about'));

    expect(requestedPaths).toEqual([]);
    expect(appHandler).toHaveBeenCalledOnce();
  });

  it.each([
    ['dot-dot segments', '/assets/../../etc/passwd'],
    ['percent-encoded dot-dot', '/assets/%2e%2e/%2e%2e/etc/passwd'],
    ['mixed-case encoded dot-dot', '/assets/%2E%2e/%2e%2E/etc/passwd'],
    ['backslash separators', '/assets/..\\..\\etc\\passwd'],
    ['encoded slash', '/assets/..%2f..%2f..%2fetc/passwd'],
    ['encoded backslash', '/assets/..%5c..%5cetc/passwd'],
    ['double encoded dots', '/assets/%252e%252e/%252e%252e/etc/passwd'],
    ['traversal after a real segment', '/assets/img/../../../etc/passwd'],
  ])('never reads outside the static directory: %s', async (_name, pathname) => {
    const appHandler = vi.fn(() => new Response('app'));
    createServerHandler({}, appHandler);
    const root = resolve(staticDirectory);

    // Build the URL by hand so the test sees what a raw request line would carry.
    await fetchHandler()(new Request(`http://localhost${pathname}`));

    for (const path of requestedPaths) {
      expect(resolve(path).startsWith(root + sep)).toBe(true);
    }
  });
});

describe('createServerHandler: app handler and hooks', () => {
  it('runs beforeFetch first and uses its response when it returns one', async () => {
    const appHandler = vi.fn(() => new Response('app'));
    createServerHandler({ beforeFetch: () => new Response('blocked', { status: 403 }) }, appHandler);

    const response = await fetchHandler()(new Request('http://localhost/'));

    expect(response.status).toBe(403);
    expect(appHandler).not.toHaveBeenCalled();
  });

  it('continues to the app when beforeFetch returns null', async () => {
    createServerHandler({ beforeFetch: () => null }, () => new Response('app'));

    expect(await (await fetchHandler()(new Request('http://localhost/'))).text()).toBe('app');
  });

  it('runs afterFetch only when the app returns nothing', async () => {
    const afterFetch = vi.fn(() => new Response('fallback', { status: 200 }));
    createServerHandler({ afterFetch }, () => null);

    const response = await fetchHandler()(new Request('http://localhost/anything'));

    expect(afterFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('fallback');
  });

  it('skips afterFetch when the app answers', async () => {
    const afterFetch = vi.fn(() => new Response('fallback'));
    createServerHandler({ afterFetch }, () => new Response('app'));

    await fetchHandler()(new Request('http://localhost/'));

    expect(afterFetch).not.toHaveBeenCalled();
  });

  it('answers a plain 404 when neither the app nor afterFetch has a response (there is no SPA fallback)', async () => {
    createServerHandler({ afterFetch: () => null }, () => null);

    const response = await fetchHandler()(new Request('http://localhost/nope'));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
  });

  it('turns an app error into a 500 that shows the message in development', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createServerHandler({ development: true }, () => {
      throw new Error('boom');
    });

    const response = await fetchHandler()(new Request('http://localhost/'));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Server Error: boom');
  });

  it('hides the error message in production', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createServerHandler({ development: false }, () => Promise.reject(new Error('secret detail')));

    const response = await fetchHandler()(new Request('http://localhost/'));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
  });
});

describe('setupGracefulShutdown', () => {
  it('stops the server, runs cleanup, then exits 0 on SIGTERM and SIGINT', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => {
      throw new Error(`exit ${String(code)}`);
    });
    const cleanup = vi.fn(() => Promise.resolve());
    const server = createServerHandler({}, () => new Response('app'));
    const termBefore = process.listeners('SIGTERM');
    const intBefore = process.listeners('SIGINT');

    setupGracefulShutdown(server, cleanup);

    const termAdded = process.listeners('SIGTERM').filter(l => !termBefore.includes(l));
    const intAdded = process.listeners('SIGINT').filter(l => !intBefore.includes(l));
    const added: { signal: NodeJS.Signals; listeners: ((signal: never) => void)[] }[] = [
      { signal: 'SIGTERM', listeners: termAdded },
      { signal: 'SIGINT', listeners: intAdded },
    ];
    try {
      for (const { signal, listeners } of added) {
        expect(listeners, signal).toHaveLength(1);
        stopMock.mockClear();
        cleanup.mockClear();
        await expect(Promise.resolve(Reflect.apply(listeners[0] ?? (() => undefined), undefined, [signal]))).rejects.toThrow('exit 0');
        expect(stopMock).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledOnce();
      }
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      for (const listener of termAdded) process.removeListener('SIGTERM', listener);
      for (const listener of intAdded) process.removeListener('SIGINT', listener);
    }
  });
});
