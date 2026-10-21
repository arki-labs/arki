import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearCachesOnUserChange } from './user-caches.js';

/** In-memory Cache Storage: enough of the API for the owner record and the cache sweep. */
class MemoryCacheStorage {
  readonly stores = new Map<string, Map<string, string>>();

  async open(name: string) {
    const entries = this.stores.get(name) ?? new Map<string, string>();
    this.stores.set(name, entries);
    return {
      match: async (key: string) => {
        const body = entries.get(key);
        return body === undefined ? undefined : new Response(body);
      },
      put: async (key: string, response: Response) => {
        entries.set(key, await response.text());
      },
      delete: async (key: string) => entries.delete(key),
    };
  }

  async keys() {
    return [...this.stores.keys()];
  }

  async delete(name: string) {
    return this.stores.delete(name);
  }

  /** Fills the caches a signed-in session leaves behind. */
  fill() {
    this.stores.set('workbox-precache-v2-https://app.test/', new Map([['/assets/app.js', 'js']]));
    this.stores.set('app-navigations', new Map([['/reader/1', '<html>private</html>']]));
    this.stores.set('app-api', new Map([['/api/items', '{"items":[]}']]));
  }
}

let storage: MemoryCacheStorage;

beforeEach(() => {
  storage = new MemoryCacheStorage();
  vi.stubGlobal('caches', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clearCachesOnUserChange', () => {
  it('keeps the caches for the user who filled them, so a returning reader still works offline', async () => {
    await clearCachesOnUserChange('usr_a');
    storage.fill();

    await clearCachesOnUserChange('usr_a');

    expect(await storage.keys()).toContain('app-navigations');
    expect(await storage.keys()).toContain('app-api');
  });

  it("drops the first user's pages when another user signs in without a sign-out", async () => {
    await clearCachesOnUserChange('usr_a');
    storage.fill();

    await clearCachesOnUserChange('usr_b');

    const names = await storage.keys();
    expect(names).not.toContain('app-navigations');
    expect(names).not.toContain('app-api');
    // Built static files are the same for everyone: dropping them would only break offline start-up.
    expect(names).toContain('workbox-precache-v2-https://app.test/');
  });

  it('drops the pages on sign-out, so nobody signed in later can read them', async () => {
    await clearCachesOnUserChange('usr_a');
    storage.fill();

    await clearCachesOnUserChange(null);

    expect(await storage.keys()).not.toContain('app-navigations');
  });

  it('drops pages nobody is recorded for when a user signs in, since they could be anyone\'s', async () => {
    storage.fill();

    await clearCachesOnUserChange('usr_b');

    expect(await storage.keys()).not.toContain('app-navigations');
  });

  it('keeps public pages a signed-out visitor cached while nobody was signed in', async () => {
    await clearCachesOnUserChange(null);
    storage.fill();

    await clearCachesOnUserChange(null);

    expect(await storage.keys()).toContain('app-navigations');
  });
});
