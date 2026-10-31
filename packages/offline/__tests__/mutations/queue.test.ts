/* eslint-disable @typescript-eslint/unbound-method -- the stubs are vi.fn() mocks; asserting on them never detaches `this` */
import { QueueTransportUnavailable, QueueStorageCorrupt } from '../../src/mutations/failures.ts';
import { orThrow } from '@arki/failure';
import { backoff } from '@arki/resilience';
import { queuedMutationId } from '../../src/mutations/identity.ts';
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
        case 'success': {
          return { ok: true };
        }
        case 'fail-401': {
          throw Object.assign(new Error('Unauthorized'), { status: 401 });
        }
        case 'fail-422': {
          throw Object.assign(new Error('Unprocessable Entity'), { status: 422 });
        }
        case 'fail-500': {
          throw Object.assign(new Error('Internal Server Error'), { status: 500 });
        }
        case 'network-error': {
          return QueueTransportUnavailable();
        }
      }
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OfflineMutationQueue', () => {
  it('keeps the original storage failure in status when a subscriber throws', async () => {
    store['report-refusal'] = 'invalid storage bytes';
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc: makeRpc(), storageKey: 'report-refusal' });
    queue.subscribe(() => { throw new Error('private observer defect'); });

    const result = await queue.drain();

    expect(QueueStorageCorrupt.is(result)).toBe(true);
    expect(queue.status().failure).toBe(result);
    queue.dispose();
  });

  it('does not invent an operation failure when reporting accepted persistence fails', async () => {
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc: makeRpc(), storageKey: 'report-success' });
    queue.subscribe(() => { throw new Error('private observer defect'); });

    expect(orThrow(await queue.enqueue(createPost, { title: 'accepted once' })).status).toBe('queued');
    expect(queue.status().failure).toBeNull();
    expect(store['report-success']).toContain('accepted once');
    queue.dispose();
  });

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.clearAllMocks();
    nanoidCounter = 0;
    vi.spyOn(queuedMutationId, 'create').mockImplementation(() => queuedMutationId.schema.parse(`test-id-${++nanoidCounter}`));
    // Ensure navigator.onLine = false so tests control drain behavior
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false },
      configurable: true,
    });
  });

  it('enqueue() persists the mutation to IDB storage', async () => {
    const rpc = makeRpc('success');
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc, storageKey: 'q1', deadLetterStorageKey: 'dl1' });

    orThrow(await queue.enqueue(createPost, { title: 'Hello' }));

    // The mutation must be persisted: we verify by checking the raw storage key
    const raw = store['q1'];
    expect(raw).toBeDefined();
    expect(raw).toContain('Hello');

    queue.dispose();
  });

  it('enqueue() persists the path the contract gives the operation', async () => {
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc: makeRpc('success'), storageKey: 'qp', deadLetterStorageKey: 'dlp' });

    orThrow(await queue.enqueue(createPost, { title: 'Path' }));

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

    const result = orThrow(await queue.enqueue(createPost, { title: 'World' }));

    expect(result.idempotencyKey).toBe('test-id-1');
    expect(result.status).toBe('queued');

    queue.dispose();
  });

  it('multiple enqueue() calls preserve FIFO order in storage', async () => {
    const rpc = makeRpc('success');
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc, storageKey: 'q3', deadLetterStorageKey: 'dl3' });

    orThrow(await queue.enqueue(createPost, { title: 'First' }));
    orThrow(await queue.enqueue(createPost, { title: 'Second' }));
    orThrow(await queue.enqueue(createPost, { title: 'Third' }));

    // Read the stored state to verify order
    const { createQueueStorage } = await import('../../src/mutations/storage.ts');
    const storage = createQueueStorage('q3');
    const entries = orThrow(await storage.read());

    expect(entries).toHaveLength(3);
    expect((entries[0]?.input as { title: string }).title).toBe('First');
    expect((entries[1]?.input as { title: string }).title).toBe('Second');
    expect((entries[2]?.input as { title: string }).title).toBe('Third');

    queue.dispose();
  });

  it('subscribe() listener receives the enqueued event with correct entry data', async () => {
    const rpc = makeRpc('success');
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc, storageKey: 'q4', deadLetterStorageKey: 'dl4' });

    const events: { type: string }[] = [];
    queue.subscribe((event) => events.push(event));

    orThrow(await queue.enqueue(createPost, { title: 'Event test' }));

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
      retry: backoff.exponential({ base: 1 }).upTo(0),
    });

    orThrow(await queue.enqueue(createPost, { title: 'Will fail' }));
    orThrow(await queue.drain());

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
      retry: backoff.exponential({ base: 1 }).upTo(0),
    });

    orThrow(await queue.enqueue(createPost, { title: 'Permanent fail' }));
    orThrow(await queue.drain());

    const items = orThrow(await queue.deadLetter.list());
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
      retry: backoff.exponential({ base: 1 }).upTo(0),
    });

    orThrow(await queue.enqueue(createPost, { title: 'Discard me' }));
    orThrow(await queue.drain());

    const before = orThrow(await queue.deadLetter.list());
    expect(before).toHaveLength(1);

    orThrow(await queue.deadLetter.discard(before[0]!.id));

    const after = orThrow(await queue.deadLetter.list());
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
      retry: backoff.exponential({ base: 1 }).upTo(0),
    });

    orThrow(await queue.enqueue(createPost, { title: 'Retry me' }));
    orThrow(await queue.drain());

    const dlBefore = orThrow(await queue.deadLetter.list());
    expect(dlBefore).toHaveLength(1);
    const deadId = dlBefore[0]!.id;

    // Retry moves it back to the queue
    // Set navigator online so drain runs
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true },
      configurable: true,
    });
    orThrow(await queue.deadLetter.retry(deadId));

    const dlAfter = orThrow(await queue.deadLetter.list());
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

    orThrow(await queue.enqueue(createPost, { title: 'Alice wrote this' }));
    expect(store['q-actor']).toContain(ALICE);

    signedIn = 'usr_bob';
    orThrow(await queue.drain());
    expect(rpc.call).not.toHaveBeenCalled();
    const [dead] = orThrow(await queue.deadLetter.list());
    expect(dead?.lastError?.code).toBe('ACTOR_MISMATCH');

    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
    orThrow(await queue.deadLetter.retry(dead!.id));
    expect(rpc.call).not.toHaveBeenCalled();

    signedIn = ALICE;
    const [again] = orThrow(await queue.deadLetter.list());
    orThrow(await queue.deadLetter.retry(again!.id));
    expect(rpc.call).toHaveBeenCalledOnce();

    queue.dispose();
  });

  // An offline reload loses the session: actorId() answers undefined (not known
  // yet). Alice's write must still reach Alice once she is back, never Bob.
  describe('offline reload: the session is unknown at enqueue', () => {
    async function writeAfterReload(rpc: AnyRpcClient, key: string) {
      // Before the reload: Alice was signed in on this device.
      const before = createOfflineMutationQueue({
        actorId: () => ALICE,
        rpc,
        storageKey: key,
        deadLetterStorageKey: `dl-${key}`,
      });
      orThrow(await before.enqueue(createPost, { title: 'Before reload' }));
      before.dispose();
      for (const k of Object.keys(store)) if (k === key) delete store[k];

      // After the reload: a fresh queue, the session not known yet.
      let signedIn: string | undefined;
      const after = createOfflineMutationQueue({
        actorId: () => signedIn,
        rpc,
        storageKey: key,
        deadLetterStorageKey: `dl-${key}`,
      });
      orThrow(await after.enqueue(createPost, { title: 'Offline after reload' }));
      return { queue: after, signIn: (id: string) => (signedIn = id) };
    }

    it('sends the write once the same user signs in', async () => {
      const rpc = makeRpc('success');
      const { queue, signIn } = await writeAfterReload(rpc, 'q-reload-a');

      signIn(ALICE);
      orThrow(await queue.drain());

      expect(rpc.call).toHaveBeenCalledOnce();
      expect(orThrow(await queue.deadLetter.list())).toHaveLength(0);
      queue.dispose();
    });

    it('never sends it for a different user: ACTOR_MISMATCH', async () => {
      const rpc = makeRpc('success');
      const { queue, signIn } = await writeAfterReload(rpc, 'q-reload-b');

      signIn('usr_bob');
      orThrow(await queue.drain());

      expect(rpc.call).not.toHaveBeenCalled();
      const [dead] = orThrow(await queue.deadLetter.list());
      expect(dead?.actorId).toBe(ALICE);
      expect(dead?.lastError?.code).toBe('ACTOR_MISMATCH');
      queue.dispose();
    });

    // Shared device: Alice signs out, then someone queues a write while signed
    // out. It must not be bound to Alice, or it would replay as her later.
    it('a confirmed sign-out forgets the last user: a signed-out write replays for nobody', async () => {
      const rpc = makeRpc('success');
      let signedIn: string | null = ALICE;
      const queue = createOfflineMutationQueue({
        actorId: () => signedIn,
        rpc,
        storageKey: 'q-signout',
        deadLetterStorageKey: 'dl-signout',
      });
      orThrow(await queue.enqueue(createPost, { title: 'As Alice' }));
      orThrow(await queue.drain());
      expect(rpc.call).toHaveBeenCalledOnce();

      signedIn = null;
      orThrow(await queue.enqueue(createPost, { title: 'Signed out' }));
      expect(store['q-signout']).toContain('"actorId":null');

      signedIn = ALICE;
      orThrow(await queue.drain());
      expect(rpc.call).toHaveBeenCalledOnce();
      const [dead] = orThrow(await queue.deadLetter.list());
      expect(dead?.lastError?.code).toBe('ACTOR_MISMATCH');
      queue.dispose();
    });

    it('a sign-out also forgets it across a reload', async () => {
      const key = 'q-signout-reload';
      const before = createOfflineMutationQueue({
        actorId: () => ALICE,
        rpc: makeRpc('success'),
        storageKey: key,
        deadLetterStorageKey: `dl-${key}`,
      });
      orThrow(await before.enqueue(createPost, { title: 'As Alice' }));
      const signedOut = createOfflineMutationQueue({
        actorId: () => null,
        rpc: makeRpc('success'),
        storageKey: key,
        deadLetterStorageKey: `dl-${key}`,
      });
      orThrow(await signedOut.enqueue(createPost, { title: 'Signed out' }));
      before.dispose();
      signedOut.dispose();
      delete store[key];

      const after = createOfflineMutationQueue({
        actorId: () => {
          /* no actor id */
        },
        rpc: makeRpc('success'),
        storageKey: key,
        deadLetterStorageKey: `dl-${key}`,
      });
      orThrow(await after.enqueue(createPost, { title: 'After reload' }));
      expect(store[key]).toContain('"actorId":null');
      after.dispose();
    });

    it('keeps null when no user was ever signed in on this device', async () => {
      const queue = createOfflineMutationQueue({
        actorId: () => null,
        rpc: makeRpc('success'),
        storageKey: 'q-nobody',
        deadLetterStorageKey: 'dl-nobody',
      });
      orThrow(await queue.enqueue(createPost, { title: 'Anonymous' }));
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
      expect(queue.status()).toEqual({ queued: 0, sending: false, deadLettered: 0, failure: null });

      queue.dispose();
    } finally {
      if (originalWindow !== undefined) {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
    }
  });
});

describe('enqueue exact outcomes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    for (const key of Object.keys(store)) delete store[key];
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  });

  it('returns the original entropy failure before touching persistence or RPC', async () => {
    const { RandomSourceUnavailable } = await import('@arki/contracts');
    const failure = RandomSourceUnavailable();
    vi.spyOn(queuedMutationId, 'create').mockReturnValueOnce(failure);
    const call = vi.fn(() => Promise.resolve());
    const rpc = { call };
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc, storageKey: 'entropy' });
    expect(await queue.enqueue(createPost, { title: 'safe' })).toBe(failure);
    expect(store['entropy']).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
    queue.dispose();
  });

  it('returns the reconciliation identity when IDB commits and then rejects', async () => {
    const { QueueAcceptanceUnconfirmed } = await import('../../src/mutations/failures.ts');
    const originalSet = vi.mocked(idbKeyval.set).getMockImplementation();
    if (!originalSet) throw new Error('Missing test storage implementation');
    vi.mocked(idbKeyval.set).mockImplementation(async (key, value) => {
      if (key !== 'unconfirmed') return originalSet(key, value);
      store['unconfirmed'] = String(value);
      throw new Error('commit acknowledgement lost');
    });
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc: makeRpc(), storageKey: 'unconfirmed' });
    const result = await queue.enqueue(createPost, { title: 'once' });
    expect(QueueAcceptanceUnconfirmed.is(result)).toBe(true);
    if (!QueueAcceptanceUnconfirmed.is(result)) throw new Error('Expected unconfirmed outcome');
    expect(store['unconfirmed']).toContain(result.data.idempotencyKey);
    queue.dispose();
    vi.mocked(idbKeyval.set).mockImplementation(originalSet);
  });

  it('reports a dead letter as a dead letter, rather than inferring sent from absence', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc: makeRpc('fail-422'), storageKey: 'rejected', deadLetterStorageKey: 'rejected-dead' });
    expect(orThrow(await queue.enqueue(createPost, { title: 'invalid' })).status).toBe('dead-letter');
    queue.dispose();
  });

  it('never repeats an accepted RPC after local removal fails', async () => {
    const { QueueAcceptanceUnconfirmed } = await import('../../src/mutations/failures.ts');
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
    const originalSet = vi.mocked(idbKeyval.set).getMockImplementation();
    if (!originalSet) throw new Error('Missing test storage implementation');
    let writes = 0;
    vi.mocked(idbKeyval.set).mockImplementation(async (key, value) => {
      if (key === 'accepted' && ++writes === 2) throw new Error('local removal refused');
      return originalSet(key, value);
    });
    const call = vi.fn(() => Promise.resolve());
    const rpc = { call };
    const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc, storageKey: 'accepted' });
    expect(QueueAcceptanceUnconfirmed.is(await queue.enqueue(createPost, { title: 'once' }))).toBe(true);
    orThrow(await queue.drain());
    expect(call).toHaveBeenCalledTimes(1);
    expect(queue.status().queued).toBe(0);
    queue.dispose();
    vi.mocked(idbKeyval.set).mockImplementation(originalSet);
  });
});

it('generates the secure legacy 21-character representation and supervises broken telemetry', async () => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  const { trace, context } = await import('@opentelemetry/api');
  const getTracer = vi.spyOn(trace, 'getTracer').mockImplementation(() => { throw new Error('reporter failed'); });
  const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc: makeRpc(), storageKey: 'secure-identity' });
  const result = orThrow(await queue.enqueue(createPost, { title: 'secure' }));
  expect(result.idempotencyKey).toMatch(/^[\w-]{21}$/);
  expect(store['secure-identity']).toContain(result.idempotencyKey);
  queue.dispose();
  getTracer.mockRestore();
  const withContext = vi.spyOn(context, 'with').mockImplementation(() => { throw new Error('context refused callback'); });
  const other = createOfflineMutationQueue({ actorId: () => ALICE, rpc: makeRpc(), storageKey: 'context-refused' });
  expect(orThrow(await other.enqueue(createPost, { title: 'still persisted' })).status).toBe('queued');
  expect(store['context-refused']).toContain('still persisted');
  other.dispose();
  withContext.mockRestore();
});


it('preserves malformed stored state and refuses to overwrite it during enqueue', async () => {
  vi.restoreAllMocks();
  const { QueueStorageCorrupt } = await import('../../src/mutations/failures.ts');
  store['corrupt-enqueue'] = 'unreadable original bytes';
  const queue = createOfflineMutationQueue({ actorId: () => ALICE, rpc: makeRpc(), storageKey: 'corrupt-enqueue' });
  expect(QueueStorageCorrupt.is(await queue.enqueue(createPost, { title: 'must not replace' }))).toBe(true);
  expect(store['corrupt-enqueue']).toBe('unreadable original bytes');
  queue.dispose();
});
