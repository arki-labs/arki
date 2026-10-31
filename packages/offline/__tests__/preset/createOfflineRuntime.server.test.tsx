import { useQuery } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// No IndexedDB on the server. The stand-in only keeps the import from touching a real one.
vi.mock('idb-keyval', () => ({
  get: vi.fn(() => Promise.resolve()),
  set: vi.fn(() => Promise.resolve()),
  del: vi.fn(() => Promise.resolve()),
}));

const { createOfflineRuntime } = await import('../../src/preset/createOfflineRuntime.ts');

const SCHEDULE_KEY = ['digest', 'preferences'];

/** What the owner's request puts in the cache while the server renders their page. */
function OwnerPage() {
  const { data } = useQuery({ queryKey: SCHEDULE_KEY, queryFn: () => 'unused', initialData: 'owner: Mondays 07:00' });
  return <p>{data}</p>;
}

/** A stranger's request renders the same page, and must start from an empty cache. */
function StrangerPage() {
  const { data } = useQuery({ queryKey: SCHEDULE_KEY, queryFn: () => 'unused', enabled: false });
  return <p>{data ?? 'nothing cached'}</p>;
}

describe('createOfflineRuntime on the server', () => {
  // The runtime is created once at module load, and on the server that module serves every request.
  // One shared cache would put the owner's data in a stranger's server-rendered page.
  it('gives each server render its own cache, so one request never sees another request data', () => {
    const offline = createOfflineRuntime({ tier: 'cache-only', appId: 'leak-test' });

    const ownerHtml = renderToString(<offline.Provider><OwnerPage /></offline.Provider>);
    const strangerHtml = renderToString(<offline.Provider><StrangerPage /></offline.Provider>);

    expect(ownerHtml).toContain('owner: Mondays 07:00');
    expect(strangerHtml).toContain('nothing cached');
    expect(strangerHtml).not.toContain('owner');
  });

  // A module-level client on the server is exactly the shared cache above, so reaching it must fail loudly.
  it('refuses to hand out the browser query client on the server', () => {
    const offline = createOfflineRuntime({ tier: 'cache-only', appId: 'leak-test' });

    expect(() => offline.queryClient).toThrow(/only in the browser/);
  });
});

describe('createOfflineRuntime dispose', () => {
  // The queue listens to the window's online and offline events. A runtime that is torn down (a test, a
  // hot reload) must take those listeners with it, or every old queue keeps replaying.
  it('removes the queue window listeners', () => {
    const added: string[] = [];
    const removed: string[] = [];
    vi.stubGlobal('window', {
      addEventListener: (type: string) => added.push(type),
      removeEventListener: (type: string) => removed.push(type),
    });
    const offline = createOfflineRuntime({
      tier: 'queue',
      appId: 'dispose-test',
      rpc: { call: () => Promise.resolve() },
      actorId: () => null,
    });
    expect(added.toSorted()).toEqual(['offline', 'online']);

    offline.dispose();

    expect(removed.toSorted()).toEqual(['offline', 'online']);
    vi.unstubAllGlobals();
  });
});

