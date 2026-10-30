/**
 * The `dot dev` console: a menu of the pages units registered, and each page as the unit's projection module drew it.
 *
 * Why these tests exist: the console must not know what a page shows, and it must show a reason when the app
 * cannot be read (an empty page would look like an app with nothing in it). The server is real (a socket on a
 * free port); only `dot explain` is a stub, because its output is covered by the explain tests.
 */
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

describe('the dev console', () => {
  it('lists each page once, from the projections that registered a console title', async () => {
    const base = await open(stub().runner);
    const html = await (await fetch(base)).text();
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
    expect((await fetch(`${base}page/openapi`)).status).toBe(404);
    expect((await fetch(`${base}page/..%2Fetc`)).status).toBe(404);
    expect(calls.some(args => args.includes('openapi'))).toBe(false);
  });

  it('shows why the app could not be read, escaped, instead of an empty page', async () => {
    const base = await open(stub({ '': { ok: false, message: 'dot.app_import_failed <boom>' } }).runner);
    const response = await fetch(base);
    const html = await response.text();
    expect(response.status).toBe(500);
    expect(html).toContain('dot.app_import_failed &lt;boom&gt;');
  });

  it('answers only GET', async () => {
    const base = await open(stub().runner);
    expect((await fetch(base, { method: 'POST' })).status).toBe(405);
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
