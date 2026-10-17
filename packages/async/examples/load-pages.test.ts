import { describe, expect, it } from 'vitest';

import { MockClock } from '@arki/clock';

import type { PageClient } from './load-pages.js';
import { ASYNC_ERROR_CODES, AsyncError } from '../src/index.js';
import { loadPages } from './load-pages.js';

function fakeClient(clock: MockClock, latencyMs: number): { client: PageClient; closed: () => boolean } {
  let closed = false;
  const client: PageClient = {
    load: (url, signal) => clock.sleep(latencyMs, signal).then(() => `body of ${url}`),
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };
  return { client, closed: () => closed };
}

const urls = Array.from({ length: 8 }, (_, index) => `https://example.com/${String(index)}`);

describe('loadPages', () => {
  it('returns every page in input order and closes the client', async () => {
    const clock = new MockClock();
    const { client, closed } = fakeClient(clock, 1000);
    const pages = loadPages(urls, () => Promise.resolve(client), { clock });
    await clock.advanceAsync(2000); // 8 pages, 4 at a time, 1 s each
    expect(await pages).toEqual(urls.map(url => `body of ${url}`));
    expect(closed()).toBe(true);
  });

  it('times out at five seconds with ARKI_ASYNC_E004 and still closes the client', async () => {
    const clock = new MockClock();
    const { client, closed } = fakeClient(clock, 4000); // two waves = 8 s, past the deadline
    const pages = loadPages(urls, () => Promise.resolve(client), { clock });
    const settled = pages.catch((error: unknown) => error);
    await clock.advanceAsync(5000);
    const error = await settled;
    expect(error).toBeInstanceOf(AsyncError);
    expect(error instanceof AsyncError && error.code).toBe(ASYNC_ERROR_CODES.timedOut);
    expect(closed()).toBe(true);
  });
});
