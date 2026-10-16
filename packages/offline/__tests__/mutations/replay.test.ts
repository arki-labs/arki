import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueuedMutation, AnyRpcClient, QueueEvent } from '../../src/mutations/queue.ts';
import type { QueueStorage } from '../../src/mutations/storage.ts';
import type { DeadLetterStore } from '../../src/mutations/dead-letter.ts';

// ---------------------------------------------------------------------------
// In-memory IDB mock (needed by imports)
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

const { createReplayLoop } = await import('../../src/mutations/replay.ts');

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ALICE = 'usr_alice';

function makeEntry(id: string, attempts = 0): QueuedMutation {
  return {
    id,
    idempotencyKey: id,
    procedurePath: ['todos', 'create'],
    input: { title: `Task ${id}` },
    actorId: ALICE,
    enqueuedAt: Date.now(),
    attempts,
  };
}

function makeStorage(initial: QueuedMutation[] = []): QueueStorage {
  let entries = [...initial];
  return {
    read: vi.fn(async () => [...entries]),
    write: vi.fn(async (next: QueuedMutation[]) => {
      entries = [...next];
    }),
    clear: vi.fn(async () => {
      entries = [];
    }),
  };
}

function makeDeadLetterStore(): DeadLetterStore & { _entries: QueuedMutation[] } {
  const _entries: QueuedMutation[] = [];
  const listeners = new Set<() => void>();
  return {
    _entries,
    list: vi.fn(async () => [..._entries] as readonly QueuedMutation[]),
    add: vi.fn(async (entry: QueuedMutation) => {
      _entries.push(entry);
      for (const l of listeners) l();
    }),
    remove: vi.fn(async (id: string) => {
      const idx = _entries.findIndex((m) => m.id === id);
      if (idx !== -1) _entries.splice(idx, 1);
      for (const l of listeners) l();
    }),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
}

function makeRpc(
  behavior:
    | 'success'
    | 'fail-401'
    | 'fail-422'
    | 'fail-500'
    | 'network-error'
    | ((call: number) => 'success' | 'fail-401' | 'fail-422' | 'fail-500' | 'network-error') =
    'success',
): AnyRpcClient & { calls: Array<{ path: readonly string[]; headers: Record<string, string> }> } {
  let callIndex = 0;
  const calls: Array<{ path: readonly string[]; headers: Record<string, string> }> = [];

  return {
    calls,
    call: vi.fn(
      async (
        path: readonly string[],
        _input: unknown,
        headers: Record<string, string> = {},
      ) => {
        const decision = typeof behavior === 'function' ? behavior(callIndex++) : behavior;
        calls.push({ path, headers });

        switch (decision) {
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
      },
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReplayLoop', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('happy path: drains 4 mutations in FIFO order with correct Idempotency-Key headers', async () => {
    const entries = [
      makeEntry('id-1'),
      makeEntry('id-2'),
      makeEntry('id-3'),
      makeEntry('id-4'),
    ];
    const storage = makeStorage(entries);
    const dlStore = makeDeadLetterStore();
    const rpc = makeRpc('success');
    const events: QueueEvent[] = [];

    const loop = createReplayLoop({
      actorId: () => ALICE,
      storage,
      dlStore,
      rpc,
      maxRetries: 3,
      backoff: () => 0,
      onStateChange: vi.fn(),
      emit: (e) => events.push(e),
    });

    await loop.drainNow();

    // All 4 rpc.call invocations happened in FIFO order
    expect(rpc.calls).toHaveLength(4);
    expect(rpc.calls.map((c) => c.headers['Idempotency-Key'])).toEqual([
      'id-1',
      'id-2',
      'id-3',
      'id-4',
    ]);

    // Correct procedure path was used
    expect(rpc.calls[0]?.path).toEqual(['todos', 'create']);

    // Queue is now empty — write was called to remove each entry
    const remaining = await storage.read();
    expect(remaining).toHaveLength(0);

    // 4 'sent' events emitted
    const sentEvents = events.filter((e) => e.type === 'sent');
    expect(sentEvents).toHaveLength(4);

    // Dead-letter store is empty
    expect(dlStore._entries).toHaveLength(0);
  });

  it('401 halts the replay loop and emits auth-required; queue entry is preserved', async () => {
    const entries = [makeEntry('id-1'), makeEntry('id-2')];
    const storage = makeStorage(entries);
    const dlStore = makeDeadLetterStore();
    const rpc = makeRpc('fail-401');
    const events: QueueEvent[] = [];

    const loop = createReplayLoop({
      actorId: () => ALICE,
      storage,
      dlStore,
      rpc,
      maxRetries: 3,
      backoff: () => 0,
      onStateChange: vi.fn(),
      emit: (e) => events.push(e),
    });

    await loop.drainNow();

    // auth-required was emitted
    expect(events.some((e) => e.type === 'auth-required')).toBe(true);

    // Nothing was dead-lettered
    expect(dlStore._entries).toHaveLength(0);

    // Queue entries are still in storage (preserved for retry after auth)
    const remaining = await storage.read();
    expect(remaining.length).toBeGreaterThan(0);
  });

  it('4xx non-auth dead-letters the entry and emits dead-letter event', async () => {
    const entries = [makeEntry('id-1')];
    const storage = makeStorage(entries);
    const dlStore = makeDeadLetterStore();
    const rpc = makeRpc('fail-422');
    const events: QueueEvent[] = [];

    const loop = createReplayLoop({
      actorId: () => ALICE,
      storage,
      dlStore,
      rpc,
      maxRetries: 3,
      backoff: () => 0,
      onStateChange: vi.fn(),
      emit: (e) => events.push(e),
    });

    await loop.drainNow();

    // Entry moved to dead-letter store immediately (no retry for 4xx)
    expect(dlStore._entries).toHaveLength(1);
    expect(dlStore._entries[0]?.id).toBe('id-1');

    // dead-letter event emitted
    expect(events.some((e) => e.type === 'dead-letter')).toBe(true);

    // Queue is empty
    const remaining = await storage.read();
    expect(remaining).toHaveLength(0);
  });

  it('5xx retries up to maxRetries then dead-letters', async () => {
    vi.useFakeTimers();

    const entries = [makeEntry('id-fail-5xx')];
    const storage = makeStorage(entries);
    const dlStore = makeDeadLetterStore();
    const rpc = makeRpc('fail-500');
    const events: QueueEvent[] = [];
    const maxRetries = 3;

    const loop = createReplayLoop({
      actorId: () => ALICE,
      storage,
      dlStore,
      rpc,
      maxRetries,
      backoff: () => 100, // fixed 100ms backoff for test speed
      onStateChange: vi.fn(),
      emit: (e) => events.push(e),
    });

    // Start drain without awaiting (it will be async with sleeps)
    const drainPromise = loop.drainNow();

    // Advance timers past all retry backoff periods
    await vi.runAllTimersAsync();
    await drainPromise;

    // After maxRetries exhausted, entry moves to dead-letter
    expect(dlStore._entries).toHaveLength(1);
    expect(dlStore._entries[0]?.id).toBe('id-fail-5xx');

    // dead-letter event was emitted
    expect(events.some((e) => e.type === 'dead-letter')).toBe(true);

    // Queue is empty
    const remaining = await storage.read();
    expect(remaining).toHaveLength(0);

    vi.useRealTimers();
  });

  it('network error retries with backoff and eventually dead-letters', async () => {
    vi.useFakeTimers();

    const entries = [makeEntry('id-net-err')];
    const storage = makeStorage(entries);
    const dlStore = makeDeadLetterStore();
    const rpc = makeRpc('network-error');
    const events: QueueEvent[] = [];
    const maxRetries = 2;

    const loop = createReplayLoop({
      actorId: () => ALICE,
      storage,
      dlStore,
      rpc,
      maxRetries,
      backoff: () => 50,
      onStateChange: vi.fn(),
      emit: (e) => events.push(e),
    });

    const drainPromise = loop.drainNow();
    await vi.runAllTimersAsync();
    await drainPromise;

    // Entry dead-lettered after exhausting retries
    expect(dlStore._entries).toHaveLength(1);
    expect(events.some((e) => e.type === 'dead-letter')).toBe(true);

    vi.useRealTimers();
  });

  it('onDeadLetter callback fires when a mutation is dead-lettered', async () => {
    const entries = [makeEntry('id-cb')];
    const storage = makeStorage(entries);
    const dlStore = makeDeadLetterStore();
    const rpc = makeRpc('fail-422');
    const onDeadLetter = vi.fn();

    const loop = createReplayLoop({
      actorId: () => ALICE,
      storage,
      dlStore,
      rpc,
      maxRetries: 0,
      backoff: () => 0,
      onStateChange: vi.fn(),
      onDeadLetter,
      emit: vi.fn(),
    });

    await loop.drainNow();

    expect(onDeadLetter).toHaveBeenCalledOnce();
    expect(onDeadLetter.mock.calls[0]?.[0]).toMatchObject({ id: 'id-cb' });
    expect(onDeadLetter.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it('onStateChange(true) fires at start and onStateChange(false) fires at end of drain', async () => {
    const storage = makeStorage([makeEntry('id-state')]);
    const dlStore = makeDeadLetterStore();
    const rpc = makeRpc('success');
    const stateChanges: boolean[] = [];

    const loop = createReplayLoop({
      actorId: () => ALICE,
      storage,
      dlStore,
      rpc,
      maxRetries: 3,
      backoff: () => 0,
      onStateChange: (sending) => stateChanges.push(sending),
      emit: vi.fn(),
    });

    await loop.drainNow();

    expect(stateChanges[0]).toBe(true);
    expect(stateChanges[stateChanges.length - 1]).toBe(false);
  });

  it('drainNow() when queue is empty completes without rpc.call', async () => {
    const storage = makeStorage([]);
    const dlStore = makeDeadLetterStore();
    const rpc = makeRpc('success');

    const loop = createReplayLoop({
      actorId: () => ALICE,
      storage,
      dlStore,
      rpc,
      maxRetries: 3,
      backoff: () => 0,
      onStateChange: vi.fn(),
      emit: vi.fn(),
    });

    await loop.drainNow();

    expect(rpc.calls).toHaveLength(0);
  });

  // Security: the request carries the session signed in at replay, not the one
  // that queued the write. Without the actor check, Alice's offline write
  // would be created in Bob's account when Bob signs in on the same browser.
  describe('account switch', () => {
    function loopFor(signedIn: () => string | null, entries: QueuedMutation[]) {
      const storage = makeStorage(entries);
      const dlStore = makeDeadLetterStore();
      const rpc = makeRpc('success');
      const events: QueueEvent[] = [];
      const onDeadLetter = vi.fn();
      const loop = createReplayLoop({
        actorId: signedIn,
        storage,
        dlStore,
        rpc,
        maxRetries: 3,
        backoff: () => 0,
        onDeadLetter,
        onStateChange: vi.fn(),
        emit: (e) => events.push(e),
      });
      return { loop, storage, dlStore, rpc, events, onDeadLetter };
    }

    it("never sends Alice's queued write while Bob is signed in; dead-letters it as ACTOR_MISMATCH", async () => {
      const { loop, storage, dlStore, rpc, events, onDeadLetter } = loopFor(() => 'usr_bob', [makeEntry('id-1')]);

      await loop.drainNow();

      expect(rpc.calls).toHaveLength(0);
      expect(await storage.read()).toHaveLength(0);
      expect(dlStore._entries).toHaveLength(1);
      expect(dlStore._entries[0]?.lastError?.code).toBe('ACTOR_MISMATCH');
      expect(dlStore._entries[0]?.actorId).toBe(ALICE);
      expect(events.some((e) => e.type === 'dead-letter')).toBe(true);
      expect(onDeadLetter).toHaveBeenCalledOnce();
    });

    it('keeps the write queued and asks for sign-in when nobody is signed in', async () => {
      const { loop, storage, dlStore, rpc, events } = loopFor(() => null, [makeEntry('id-1')]);

      await loop.drainNow();

      expect(rpc.calls).toHaveLength(0);
      expect(await storage.read()).toHaveLength(1);
      expect(dlStore._entries).toHaveLength(0);
      expect(events.map((e) => e.type)).toEqual(['auth-required']);
    });

    it('sends the write once Alice signs back in, with no online event needed', async () => {
      let signedIn: string | null = null;
      const { loop, storage, rpc } = loopFor(() => signedIn, [makeEntry('id-1')]);

      await loop.drainNow();
      expect(rpc.calls).toHaveLength(0);

      signedIn = ALICE;
      await loop.drainNow();

      expect(rpc.calls).toHaveLength(1);
      expect(await storage.read()).toHaveLength(0);
    });

    it("sends Bob's own writes and dead-letters only Alice's in a mixed queue", async () => {
      const bobs: QueuedMutation = { ...makeEntry('id-2'), actorId: 'usr_bob' };
      const { loop, dlStore, rpc } = loopFor(() => 'usr_bob', [makeEntry('id-1'), bobs]);

      await loop.drainNow();

      expect(rpc.calls.map((c) => c.headers['Idempotency-Key'])).toEqual(['id-2']);
      expect(dlStore._entries.map((m) => m.id)).toEqual(['id-1']);
    });
  });
});
