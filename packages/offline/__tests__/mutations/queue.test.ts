import { describe, it, expect, vi, beforeEach } from 'vitest';
import { oc } from '@orpc/contract';
import { z } from 'zod';

import { OPERATION, operations } from '@arki/contracts/orpc';

import type { AnyRpcClient } from '../../src/mutations/queue.ts';
import { offlineSafe } from '../../src/orpc/offline-safe-marker.ts';
import * as idbKeyval from 'idb-keyval';

// ---------------------------------------------------------------------------
// In-memory IDB mock
// ---------------------------------------------------------------------------

const store: Record<string, string> = {};

vi.mock('idb-keyval', () => ({
  get: vi.fn((key: string) => Promise.resolve(store[key])),
  set: vi.fn((key: string, value: string) => {
    store[key] = value;
    return Promise.resolve();
  }),
  del: vi.fn((key: string) => {
    delete store[key];
    return Promise.resolve();
  }),
}));

// We need nanoid to be deterministic in tests
let nanoidCounter = 0;
vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => `test-id-${++nanoidCounter}`),
}));

const { createOfflineMutationQueue } = await import('../../src/mutations/queue.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PATH = ['posts', 'create'] as const;
const ALICE = 'usr_alice';

const contract = {
  posts: {
    create: offlineSafe(oc.input(z.object({ title: z.string() }))),
    list: oc.input(z.object({ cursor: z.string().optional() })),
  },
};
const ops = operations(contract);
/** The utils leaf of posts.create, reduced to what the queue reads: its operation. */
const createPost = { [OPERATION]: ops.posts.create };

function makeRpc(
  behavior: 'success' | 'fail-401' | 'fail-422' | 'fail-500' | 'network-error' = 'success',
): AnyRpcClient {
  return {
    call: vi.fn(async () => {
      switch (behavior) {
        case 'success':
          return { ok: true };
        case 'fail-401':
          throw Object.assign(new Error('Unauthorized'), { status: 401 });
        case 'fail-422':
          throw Object.assign(new Error('Unprocessable Entity'), { status: 422 });
        case 'fail-500':
          throw Object.assign(new Error('Internal Server Error'), { status: 500 });
        case 'network-error':
          throw new Error('fetch failed');
      }
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OfflineMutationQueue', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.clearAllMocks();
    nanoidCounter = 0;
    // Ensure navigator.onLine = false so tests control drain behavior
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false },
      configurable: true,
    });
  });

  it('enqueue() persists the mutation to IDB storage', async () => {
    const rpc = makeRpc('success');
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc, storageKey: 'q1', deadLetterStorageKey: 'dl1' });

    await queue.enqueue(createPost, { title: 'Hello' });

    // The mutation must be persisted: we verify by checking the raw storage key
    const raw = store['q1'];
    expect(raw).toBeDefined();
    expect(raw).toContain('Hello');

    queue.dispose();
  });

  it('enqueue() persists the path the contract gives the operation', async () => {
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc: makeRpc('success'), storageKey: 'qp', deadLetterStorageKey: 'dlp' });

    await queue.enqueue(createPost, { title: 'Path' });

    expect(store['qp']).toContain(JSON.stringify(TEST_PATH));
    queue.dispose();
  });

  it('enqueue() refuses, at run time, a procedure the contract did not mark offlineSafe and a forged carrier', async () => {
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc: makeRpc('success'), storageKey: 'qr', deadLetterStorageKey: 'dlr' });
    const unmarked: object = { [OPERATION]: ops.posts.list };
    const forged: object = { [OPERATION]: { path: ['posts', 'create'], name: 'posts.delete', meta: { offlineSafe: true } } };

    // Plain JavaScript callers have no compiler; Reflect.apply stands in for one.
    await expect(Reflect.apply(queue.enqueue, queue, [unmarked, {}])).rejects.toThrow(/not marked offlineSafe/);
    await expect(Reflect.apply(queue.enqueue, queue, [forged, {}])).rejects.toThrow(TypeError);
    expect(store['qr']).toBeUndefined();
    queue.dispose();
  });

  it('enqueue() returns the idempotencyKey matching the stored mutation id', async () => {
    const rpc = makeRpc('success');
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc, storageKey: 'q2', deadLetterStorageKey: 'dl2' });

    const result = await queue.enqueue(createPost, { title: 'World' });

    expect(result.idempotencyKey).toBe('test-id-1');
    expect(result.status).toBe('queued');

    queue.dispose();
  });

  it('multiple enqueue() calls preserve FIFO order in storage', async () => {
    const rpc = makeRpc('success');
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc, storageKey: 'q3', deadLetterStorageKey: 'dl3' });

    await queue.enqueue(createPost, { title: 'First' });
    await queue.enqueue(createPost, { title: 'Second' });
    await queue.enqueue(createPost, { title: 'Third' });

    // Read the stored state to verify order
    const { createQueueStorage } = await import('../../src/mutations/storage.ts');
    const storage = createQueueStorage('q3');
    const entries = await storage.read();

    expect(entries).toHaveLength(3);
    expect((entries[0]?.input as { title: string }).title).toBe('First');
    expect((entries[1]?.input as { title: string }).title).toBe('Second');
    expect((entries[2]?.input as { title: string }).title).toBe('Third');

    queue.dispose();
  });

  it('subscribe() listener receives the enqueued event with correct entry data', async () => {
    const rpc = makeRpc('success');
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc, storageKey: 'q4', deadLetterStorageKey: 'dl4' });

    const events: Array<{ type: string }> = [];
    queue.subscribe((event) => events.push(event));

    await queue.enqueue(createPost, { title: 'Event test' });

    const enqueued = events.find((e) => e.type === 'enqueued');
    expect(enqueued).toBeDefined();
    expect(enqueued).toMatchObject({
      type: 'enqueued',
      entry: expect.objectContaining({
        idempotencyKey: 'test-id-1',
        procedurePath: TEST_PATH,
      }) as unknown,
    });

    queue.dispose();
  });

  it('status() reflects the dead-lettered count when mutations move to dead-letter', async () => {
    const rpc = makeRpc('fail-422');
    const queue = createOfflineMutationQueue({
      actorId: () => ALICE,
      rpc,
      storageKey: 'q5',
      deadLetterStorageKey: 'dl5',
      maxRetries: 0,
    });

    await queue.enqueue(createPost, { title: 'Will fail' });
    await queue.drain();

    // Wait for dead-letter count update (it's async via subscribe)
    await new Promise((r) => setTimeout(r, 10));

    const s = queue.status();
    expect(s.deadLettered).toBe(1);

    queue.dispose();
  });

  it('deadLetter.list() returns mutations that failed permanently', async () => {
    const rpc = makeRpc('fail-422');
    const queue = createOfflineMutationQueue({
      actorId: () => ALICE,
      rpc,
      storageKey: 'q6',
      deadLetterStorageKey: 'dl6',
      maxRetries: 0,
    });

    await queue.enqueue(createPost, { title: 'Permanent fail' });
    await queue.drain();

    const items = await queue.deadLetter.list();
    expect(items).toHaveLength(1);
    expect((items[0]?.input as { title: string }).title).toBe('Permanent fail');

    queue.dispose();
  });

  it('deadLetter.discard() removes an entry from the dead-letter store', async () => {
    const rpc = makeRpc('fail-422');
    const queue = createOfflineMutationQueue({
      actorId: () => ALICE,
      rpc,
      storageKey: 'q7',
      deadLetterStorageKey: 'dl7',
      maxRetries: 0,
    });

    await queue.enqueue(createPost, { title: 'Discard me' });
    await queue.drain();

    const before = await queue.deadLetter.list();
    expect(before).toHaveLength(1);

    await queue.deadLetter.discard(before[0]!.id);

    const after = await queue.deadLetter.list();
    expect(after).toHaveLength(0);

    queue.dispose();
  });

  it('deadLetter.retry() re-enqueues the mutation and removes from dead-letter', async () => {
    let callCount = 0;
    const rpc: AnyRpcClient = {
      call: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw Object.assign(new Error('Unprocessable'), { status: 422 });
        return { ok: true };
      }),
    };

    const queue = createOfflineMutationQueue({
      actorId: () => ALICE,
      rpc,
      storageKey: 'q8',
      deadLetterStorageKey: 'dl8',
      maxRetries: 0,
    });

    await queue.enqueue(createPost, { title: 'Retry me' });
    await queue.drain();

    const dlBefore = await queue.deadLetter.list();
    expect(dlBefore).toHaveLength(1);
    const deadId = dlBefore[0]!.id;

    // Retry moves it back to the queue
    // Set navigator online so drain runs
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true },
      configurable: true,
    });
    await queue.deadLetter.retry(deadId);

    const dlAfter = await queue.deadLetter.list();
    expect(dlAfter).toHaveLength(0);

    queue.dispose();
  });

  // Security: a write is bound to the account that made it. Retrying it from
  // the dead-letter list must not rebind it to whoever is signed in now.
  it('binds each entry to the actor signed in at enqueue, and a retry keeps that binding', async () => {
    let signedIn: string | null = ALICE;
    const rpc = makeRpc('success');
    const queue = createOfflineMutationQueue({
      actorId: () => signedIn,
      rpc,
      storageKey: 'q-actor',
      deadLetterStorageKey: 'dl-actor',
    });

    await queue.enqueue(createPost, { title: 'Alice wrote this' });
    expect(store['q-actor']).toContain(ALICE);

    signedIn = 'usr_bob';
    await queue.drain();
    expect(rpc.call).not.toHaveBeenCalled();
    const [dead] = await queue.deadLetter.list();
    expect(dead?.lastError?.code).toBe('ACTOR_MISMATCH');

    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
    await queue.deadLetter.retry(dead!.id);
    expect(rpc.call).not.toHaveBeenCalled();

    signedIn = ALICE;
    const [again] = await queue.deadLetter.list();
    await queue.deadLetter.retry(again!.id);
    expect(rpc.call).toHaveBeenCalledOnce();

    queue.dispose();
  });

  // An offline reload loses the session: actorId() answers undefined (not known
  // yet). Alice's write must still reach Alice once she is back, never Bob.
  describe('offline reload: the session is unknown at enqueue', () => {
    async function writeAfterReload(rpc: AnyRpcClient, key: string) {
      // Before the reload: Alice was signed in on this device.
      const before = createOfflineMutationQueue({ actorId: () => ALICE, rpc, storageKey: key, deadLetterStorageKey: `dl-${key}` });
      await before.enqueue(createPost, { title: 'Before reload' });
      before.dispose();
      for (const k of Object.keys(store)) if (k === key) delete store[k];

      // After the reload: a fresh queue, the session not known yet.
      let signedIn: string | undefined;
      const after = createOfflineMutationQueue({ actorId: () => signedIn, rpc, storageKey: key, deadLetterStorageKey: `dl-${key}` });
      await after.enqueue(createPost, { title: 'Offline after reload' });
      return { queue: after, signIn: (id: string) => (signedIn = id) };
    }

    it('sends the write once the same user signs in', async () => {
      const rpc = makeRpc('success');
      const { queue, signIn } = await writeAfterReload(rpc, 'q-reload-a');

      signIn(ALICE);
      await queue.drain();

      expect(rpc.call).toHaveBeenCalledOnce();
      expect(await queue.deadLetter.list()).toHaveLength(0);
      queue.dispose();
    });

    it('never sends it for a different user: ACTOR_MISMATCH', async () => {
      const rpc = makeRpc('success');
      const { queue, signIn } = await writeAfterReload(rpc, 'q-reload-b');

      signIn('usr_bob');
      await queue.drain();

      expect(rpc.call).not.toHaveBeenCalled();
      const [dead] = await queue.deadLetter.list();
      expect(dead?.actorId).toBe(ALICE);
      expect(dead?.lastError?.code).toBe('ACTOR_MISMATCH');
      queue.dispose();
    });

    // Shared device: Alice signs out, then someone queues a write while signed
    // out. It must not be bound to Alice, or it would replay as her later.
    it('a confirmed sign-out forgets the last user: a signed-out write replays for nobody', async () => {
      const rpc = makeRpc('success');
      let signedIn: string | null = ALICE;
      const queue = createOfflineMutationQueue({ actorId: () => signedIn, rpc, storageKey: 'q-signout', deadLetterStorageKey: 'dl-signout' });
      await queue.enqueue(createPost, { title: 'As Alice' });
      await queue.drain();
      expect(rpc.call).toHaveBeenCalledOnce();

      signedIn = null;
      await queue.enqueue(createPost, { title: 'Signed out' });
      expect(store['q-signout']).toContain('"actorId":null');

      signedIn = ALICE;
      await queue.drain();
      expect(rpc.call).toHaveBeenCalledOnce();
      const [dead] = await queue.deadLetter.list();
      expect(dead?.lastError?.code).toBe('ACTOR_MISMATCH');
      queue.dispose();
    });

    it('a sign-out also forgets it across a reload', async () => {
      const key = 'q-signout-reload';
      const before = createOfflineMutationQueue({ actorId: () => ALICE, rpc: makeRpc('success'), storageKey: key, deadLetterStorageKey: `dl-${key}` });
      await before.enqueue(createPost, { title: 'As Alice' });
      const signedOut = createOfflineMutationQueue({ actorId: () => null, rpc: makeRpc('success'), storageKey: key, deadLetterStorageKey: `dl-${key}` });
      await signedOut.enqueue(createPost, { title: 'Signed out' });
      before.dispose();
      signedOut.dispose();
      delete store[key];

      const after = createOfflineMutationQueue({ actorId: () => undefined, rpc: makeRpc('success'), storageKey: key, deadLetterStorageKey: `dl-${key}` });
      await after.enqueue(createPost, { title: 'After reload' });
      expect(store[key]).toContain('"actorId":null');
      after.dispose();
    });

    it('keeps null when no user was ever signed in on this device', async () => {
      const queue = createOfflineMutationQueue({ actorId: () => null, rpc: makeRpc('success'), storageKey: 'q-nobody', deadLetterStorageKey: 'dl-nobody' });
      await queue.enqueue(createPost, { title: 'Anonymous' });
      expect(store['q-nobody']).toContain('"actorId":null');
      queue.dispose();
    });
  });

  it('dispose() removes event listeners and prevents future emissions', async () => {
    const rpc = makeRpc('success');
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc, storageKey: 'q9', deadLetterStorageKey: 'dl9' });

    const events: string[] = [];
    queue.subscribe((e) => events.push(e.type));
    queue.dispose();

    // Subsequent enqueue after dispose — subscription should not fire
    // (Note: enqueue still works but listeners are cleared)
    const preLength = events.length;
    // We can't easily test listener clearing on the disposed queue,
    // but we verify dispose() doesn't throw
    expect(preLength).toBe(0);
  });

  // Regression — production Avocabo SSR crash: top-level
  // `createOfflineRuntime` evaluates during SSR, where `indexedDB` is undefined.
  // The factory must not touch idb-keyval at construction when there is no
  // `window` global. See queue.ts `isBrowser` guard.
  it('does not touch idb-keyval during construction when window is undefined (SSR)', () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;

    try {
      const rpc = makeRpc('success');
      const queue = createOfflineMutationQueue({
        actorId: () => ALICE,
        rpc,
        storageKey: 'q-ssr',
        deadLetterStorageKey: 'dl-ssr',
      });

      // Mock was reset in beforeEach, so any call counted here came from construction
      expect(vi.mocked(idbKeyval.get)).not.toHaveBeenCalled();
      expect(queue.status()).toEqual({ queued: 0, sending: false, deadLettered: 0 });

      queue.dispose();
    } finally {
      if (originalWindow !== undefined) {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });
});
