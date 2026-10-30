/**
 * The `dot dev` console: a menu of the pages units registered, and each page as the unit's projection module drew it.
 *
 * Why these tests exist: the console must not know what a page shows, and it must show a reason when the app
 * cannot be read (an empty page would look like an app with nothing in it). The server is real (a socket on a
 * free port); only `dot explain` is a stub, because its output is covered by the explain tests.
 */
import { request as httpRequest } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import type { ExplainResult, ExplainRunner, RunningConsole } from '../dev-console.js';
import { startConsole } from '../dev-console.js';
import { freePort } from './dev-helpers.js';

let running: RunningConsole | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

const manifest = {
  projections: [
    { format: 'event-map', console: { title: 'Event map' } },
    { format: 'openapi' },
    { format: 'event-map', console: { title: 'Event map' } },
  ],
};

function stub(overrides: Partial<Record<string, ExplainResult>> = {}): { runner: ExplainRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ExplainRunner = args => {
    calls.push([...args]);
    const key = args.join(' ');
    return Promise.resolve(
      overrides[key] ??
        (key === '' ? { ok: true, data: manifest } : { ok: true, data: { page: '<p id="drawn">map of <b>things</b></p>' } }),
    );
  };
  return { runner, calls };
}

async function open(runner: ExplainRunner): Promise<string> {
  const started = await startConsole({ port: await freePort(), explain: runner });
  if ('message' in started) throw new Error(started.message);
  running = started;
  return started.url;
}

async function statusOf(url: string, init?: RequestInit): Promise<number> {
  const response = await fetch(url, init);
  return response.status;
}

async function textOf(url: string): Promise<string> {
  const response = await fetch(url);
  return response.text();
}

describe('the dev console', () => {
  it('lists each page once, from the projections that registered a console title', async () => {
    const base = await open(stub().runner);
    const html = await textOf(base);
    expect(html.match(/href="\/page\/event-map"/g)?.length).toBe(2); // the menu bar and the list
    expect(html).toContain('Event map');
    expect(html).not.toContain('openapi');
  });

  it("puts the projection module's page inside the shell, asking for it with --page", async () => {
    const { runner, calls } = stub();
    const base = await open(runner);
    const response = await fetch(`${base}page/event-map`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<p id="drawn">map of <b>things</b></p>');
    expect(html).toContain('aria-current="page"');
    expect(calls).toContainEqual(['--as', 'event-map', '--page']);
  });

  it('answers 404 for a format that registered no page, without asking explain for it', async () => {
    const { runner, calls } = stub();
    const base = await open(runner);
    expect(await statusOf(`${base}page/openapi`)).toBe(404);
    expect(await statusOf(`${base}page/..%2Fetc`)).toBe(404);
    expect(calls.some(args => args.includes('openapi'))).toBe(false);
  });

  it('shows why the app could not be read, escaped, instead of an empty page', async () => {
    const base = await open(stub({ '': { ok: false, message: 'dot.app_import_failed <boom>' } }).runner);
    const response = await fetch(base);
    const html = await response.text();
    expect(response.status).toBe(500);
    expect(html).toContain('dot.app_import_failed &lt;boom&gt;');
  });

  it('answers 404 for a malformed escape in the path, and keeps serving', async () => {
    const base = await open(stub().runner);
    expect(await statusOf(`${base}page/%E0%A4%A`)).toBe(404);
    expect(await statusOf(base)).toBe(200);
  });

  it('answers 500 when a page fails to render, and keeps serving the next request', async () => {
    let failing = true;
    const { runner } = stub();
    const flaky: ExplainRunner = args => (failing ? Promise.reject(new Error('<boom>')) : runner(args));
    const base = await open(flaky);
    const response = await fetch(base);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('&lt;boom&gt;');
    failing = false;
    expect(await statusOf(base)).toBe(200);
  });

  // WHY: a page on another site can point its own domain at 127.0.0.1 (DNS rebinding) and read the console, which
  // shows the app's file paths. Its requests carry its own domain in Host, so only the console's names may pass.
  it('refuses a request whose Host is not the console, and serves 127.0.0.1 and localhost', async () => {
    const base = await open(stub().runner);
    const { port } = new URL(base);
    const statusFor = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port: Number(port), path: '/', headers: { host } }, response => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.once('error', reject);
        request.end();
      });
    expect(await statusFor(`evil.example:${port}`)).toBe(421);
    expect(await statusFor('127.0.0.1')).toBe(421);
    expect(await statusFor(`127.0.0.1:${port}`)).toBe(200);
    expect(await statusFor(`localhost:${port}`)).toBe(200);
  });

  it('answers only GET', async () => {
    const base = await open(stub().runner);
    expect(await statusOf(base, { method: 'POST' })).toBe(405);
  });

  it('returns a message, not a throw, when the port is taken', async () => {
    const first = await startConsole({ port: await freePort(), explain: stub().runner });
    if ('message' in first) throw new Error(first.message);
    running = first;
    const port = Number(new URL(first.url).port);
    const second = await startConsole({ port, explain: stub().runner });
    expect(second).toMatchObject({ message: expect.stringContaining(String(port)) });
  });
});
