import { describe, expect, it } from 'vitest';

import { MockClock } from '@arki/clock';
import { orThrow } from '@arki/failure';

import type { PageClient } from './load-pages.js';
import { Deadline } from '../src/index.js';
import { loadPages } from './load-pages.js';

function fakeClient(clock: MockClock, latencyMs: number): { client: PageClient; closed: () => boolean } {
  let closed = false;
  const client: PageClient = {
    load: async (url, signal) => {
      // This fixture models a foreign page client with a rejection contract.
      orThrow(await clock.sleep(latencyMs, signal));
      return `body of ${url}`;
    },
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

  it('returns a typed deadline and closes the client after cancelled loads settle', async () => {
    const clock = new MockClock();
    const { client, closed } = fakeClient(clock, 4000); // two waves = 8 s, past the deadline
    const pages = loadPages(urls, () => Promise.resolve(client), { clock });
    await clock.advanceAsync(5000);
    expect(Deadline.is(await pages)).toBe(true);
    expect(closed()).toBe(true);
  });

  it('waits for a load that ignores cancellation before closing its client', async () => {
    const clock = new MockClock();
    const events: string[] = [];
    const client = {
      async load() {
        orThrow(await clock.sleep(6000));
        events.push('load settled');
        return 'page';
      },
      close() {
        events.push('client closed');
        return Promise.resolve();
      },
    };
    const pages = loadPages(['https://example.com'], () => Promise.resolve(client), { clock });
    await clock.advanceAsync(5000);
    expect(events).toEqual([]);
    await clock.advanceAsync(1000);
    expect(Deadline.is(await pages)).toBe(true);
    expect(events).toEqual(['load settled', 'client closed']);
  });
});
