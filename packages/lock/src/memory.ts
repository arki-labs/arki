/**
 * In-process hold store: mutex, counting semaphore and read/write locks.
 * Portable: no `node:*`, no timers.
 *
 * - Mutex: waiters wake in the order they began to wait, so contended work runs FIFO.
 * - Semaphore (`permits`): a key holds up to `limit` permits, each hold takes `weight`.
 *   Every release wakes all waiters in the order they began to wait, and each retries.
 *   There is no head-of-line reservation: a heavy waiter can be passed by lighter ones
 *   that fit in the free permits. The limit is remembered only while the key has a
 *   holder; a different limit while held is a `config` error.
 *   Waiters register through `permits.waiter(key, weight)`: they sleep only while their weight
 *   does not fit, and a release wakes just those that now fit.
 * - Read/write (`shared`): readers overlap, a writer excludes readers and writers, and
 *   there is no upgrade or downgrade. Writer preference: while a writer waits, new readers
 *   are refused. The manager registers the waiting writer through `shared.waiter` and
 *   keeps it registered until its last attempt has settled, so a woken writer cannot lose
 *   its turn to a reader that slips in between the wake-up and the retry. Trade-off: a caller
 *   that holds a read lock and reads the same key again (a nested read) deadlocks while a
 *   writer waits, because the writer waits for the first read and the second read waits for
 *   the writer. Do not nest reads on one key.
 *
 * The three primitives live in separate tables; the key already carries the primitive
 * (see `key.ts`), so one name can be a mutex, a semaphore and a read/write lock at once.
 */
import type {
  AcquireRequest,
  Grant,
  Guarantees,
  Key,
  PermitOps,
  PermitRequest,
  ReleaseOutcome,
  SharedOps,
  SharedRequest,
  Store,
  Waiter,
} from './types.js';
import { LockError } from './errors.js';
import { limitSchema, weightSchema } from './types.js';

const guarantees = {
  kind: 'hold',
  scope: 'process',
  wait: 'wake',
  shared: true,
  writerPreference: true,
  permits: true,
  fence: 'process',
  releasedOnCrash: 'immediate',
  clock: 'none',
  poolerSafe: true,
  runtimes: ['node', 'bun', 'deno', 'browser', 'hermes'],
} as const satisfies Guarantees;

export type MemoryGuarantees = typeof guarantees;

/** What `peek` shows about a held key. A copy: changing it changes nothing. */
export type MemoryEntry = {
  /** Mutex: the holder. Semaphore and readers: the earliest holder. */
  readonly owner: string;
  /** The newest fence handed out for this key. */
  readonly fence: bigint;
  readonly expiresAt?: number;
  /** Read/write keys: what the holders hold. */
  readonly mode?: 'read' | 'write';
  /** Semaphore keys: permits in use. */
  readonly permits?: number;
  /** Semaphore and read keys: how many holds there are. */
  readonly holders?: number;
};

export type MemoryStore = Store<MemoryGuarantees> & {
  /** Resolves when the key may be free (any primitive), or when `signal` aborts. */
  waitFor(key: Key, signal: AbortSignal): Promise<void>;
  readonly permits: PermitOps & { waiter(key: Key, weight: number): Waiter };
  readonly shared: SharedOps & { waiter(key: Key, mode: 'read' | 'write'): Waiter };
  /** The current holder of `key`, if any. For tests and debugging. */
  peek(key: Key): MemoryEntry | undefined;
};

/** A parked caller. It is woken only when `blocked()` is false at a state change. */
type Parked = { readonly wake: () => void; readonly blocked: () => boolean };

/** An attempt the store refused. (A variable, because `Promise.resolve(undefined)` is rewritten to `Promise<void>` by lint.) */
function noGrant(): Promise<Grant | undefined> {
  return Promise.resolve(new Map<string, Grant>().get(''));
}

type Pool = {
  readonly limit: number;
  inUse: number;
  /** In acquisition order. */
  readonly holders: Map<string, { readonly weight: number; readonly fence: bigint }>;
};

type Shared = {
  /** In acquisition order. */
  readonly readers: Map<string, bigint>;
  writer: { readonly token: string; readonly fence: bigint } | undefined;
  /** Writers between their first refusal and the end of their acquire loop. */
  pendingWriters: number;
};

export function memoryStore(): MemoryStore {
  const held = new Map<string, MemoryEntry>();
  const pools = new Map<string, Pool>();
  const shareds = new Map<string, Shared>();
  const waiters = new Map<string, Parked[]>();
  let lastFence = 0n;

  function nextFence(): bigint {
    lastFence += 1n;
    return lastFence;
  }

  function wakeAll(fullKey: string): void {
    const queue = waiters.get(fullKey);
    if (queue === undefined) return;
    // Only those who can now succeed wake; the rest keep their place.
    const stay = queue.filter(parked => parked.blocked());
    if (stay.length === 0) waiters.delete(fullKey);
    else waiters.set(fullKey, stay);
    for (const parked of queue) if (!stay.includes(parked)) parked.wake();
  }

  function dropIfIdle(fullKey: string, state: Shared): void {
    if (state.writer === undefined && state.readers.size === 0 && state.pendingWriters === 0) shareds.delete(fullKey);
  }

  /** Resolve when `isBlocked` turns false at a wake-up, or at once when it already is, or on abort. */
  function parkUntilWoken(fullKey: string, signal: AbortSignal, isBlocked: () => boolean): Promise<void> {
    if (!isBlocked() || signal.aborted) return Promise.resolve();
    return new Promise<void>(resolve => {
      const wake = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const parked: Parked = { wake, blocked: isBlocked };
      const onAbort = (): void => {
        const queue = waiters.get(fullKey);
        const index = queue?.indexOf(parked) ?? -1;
        if (queue !== undefined && index !== -1) queue.splice(index, 1);
        resolve();
      };
      waiters.set(fullKey, [...(waiters.get(fullKey) ?? []), parked]);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  const isHeld = (fullKey: string): boolean => {
    if (held.has(fullKey) || pools.has(fullKey)) return true;
    const state = shareds.get(fullKey);
    return state !== undefined && (state.writer !== undefined || state.readers.size > 0);
  };

  const permits: MemoryStore['permits'] = {
    acquire(key: Key, req: PermitRequest): Promise<Grant | undefined> {
      const { limit, weight } = req;
      // PermitOps is public: a caller that skips the manager must not take a negative or fractional hold.
      if (!limitSchema.safeParse(limit).success || !weightSchema.safeParse(weight).success) {
        return Promise.reject(
          new LockError({
            code: 'config',
            message: `limit ${limit} and weight ${weight} must be positive integers`,
            remediation: 'Pass a positive integer limit and weight.',
          }),
        );
      }
      if (weight > limit) {
        return Promise.reject(
          new LockError({
            code: 'config',
            message: `weight ${weight} is above the limit ${limit}`,
            remediation: 'Pass a weight of at most the limit.',
          }),
        );
      }
      const pool = pools.get(key.full);
      if (pool !== undefined && pool.limit !== limit) {
        return Promise.reject(
          new LockError({
            code: 'config',
            message: `the semaphore is held with limit ${pool.limit}, not ${limit}`,
            remediation: 'Declare one limit per semaphore key; a new limit is accepted once no hold is left.',
          }),
        );
      }
      if (pool !== undefined && pool.inUse + weight > limit) return noGrant();
      const target = pool ?? { limit, inUse: 0, holders: new Map<string, { weight: number; fence: bigint }>() };
      const fence = nextFence();
      target.inUse += weight;
      target.holders.set(req.token, { weight, fence });
      pools.set(key.full, target);
      return Promise.resolve({ key, token: req.token, fence });
    },
    release(grant: Grant): Promise<ReleaseOutcome> {
      const pool = pools.get(grant.key.full);
      const hold = pool?.holders.get(grant.token);
      if (pool === undefined || hold === undefined) return Promise.resolve('not-owner');
      pool.holders.delete(grant.token);
      pool.inUse -= hold.weight;
      if (pool.holders.size === 0) pools.delete(grant.key.full);
      wakeAll(grant.key.full);
      return Promise.resolve('released');
    },
    waiter(key: Key, weight: number): Waiter {
      return {
        waitFor(signal: AbortSignal): Promise<void> {
          // Blocked while the weight does not fit. Checked at park time too, so a permit freed since the refusal is not missed.
          return parkUntilWoken(key.full, signal, () => {
            const pool = pools.get(key.full);
            return pool !== undefined && pool.inUse + weight > pool.limit;
          });
        },
        close() {
          // Nothing to release: a permit waiter holds no state in the store.
        },
      };
    },
  };

  const shared: MemoryStore['shared'] = {
    acquire(key: Key, req: SharedRequest): Promise<Grant | undefined> {
      const state = shareds.get(key.full);
      const writerHeld = state?.writer !== undefined;
      if (req.mode === 'read') {
        // Writer preference: a waiting writer stops new readers.
        if (writerHeld || (state?.pendingWriters ?? 0) > 0) return noGrant();
      } else if (writerHeld || (state?.readers.size ?? 0) > 0) {
        return noGrant();
      }
      const target = state ?? { readers: new Map<string, bigint>(), writer: undefined, pendingWriters: 0 };
      const fence = nextFence();
      if (req.mode === 'read') target.readers.set(req.token, fence);
      else target.writer = { token: req.token, fence };
      shareds.set(key.full, target);
      return Promise.resolve({ key, token: req.token, fence });
    },
    release(grant: Grant): Promise<ReleaseOutcome> {
      const state = shareds.get(grant.key.full);
      if (state === undefined) return Promise.resolve('not-owner');
      if (state.writer?.token === grant.token) state.writer = undefined;
      else if (!state.readers.delete(grant.token)) return Promise.resolve('not-owner');
      dropIfIdle(grant.key.full, state);
      wakeAll(grant.key.full);
      return Promise.resolve('released');
    },
    waiter(key: Key, mode: 'read' | 'write'): Waiter {
      // Only a writer keeps the state alive (pendingWriters), so everyone else looks it up fresh.
      if (mode === 'write') {
        const state = shareds.get(key.full) ?? {
          readers: new Map<string, bigint>(),
          writer: undefined,
          pendingWriters: 0,
        };
        state.pendingWriters += 1;
        shareds.set(key.full, state);
      }
      let closed = false;
      return {
        waitFor(signal: AbortSignal): Promise<void> {
          return parkUntilWoken(key.full, signal, () => {
            const state = shareds.get(key.full);
            if (state === undefined) return false;
            return mode === 'write'
              ? state.writer !== undefined || state.readers.size > 0
              : state.writer !== undefined || state.pendingWriters > 0;
          });
        },
        close(): void {
          if (closed || mode !== 'write') return;
          closed = true;
          const state = shareds.get(key.full);
          if (state === undefined) return;
          state.pendingWriters -= 1;
          dropIfIdle(key.full, state);
          // Readers the writer was holding back may go now.
          if (state.pendingWriters === 0) wakeAll(key.full);
        },
      };
    },
  };

  return {
    name: 'memory',
    guarantees,
    permits,
    shared,
    acquire(key: Key, req: AcquireRequest): Promise<Grant | undefined> {
      let grant: Grant | undefined;
      if (!held.has(key.full)) {
        const fence = nextFence();
        held.set(key.full, { owner: req.token, fence });
        grant = { key, token: req.token, fence };
      }
      return Promise.resolve(grant);
    },
    release(grant: Grant): Promise<ReleaseOutcome> {
      if (held.get(grant.key.full)?.owner !== grant.token) return Promise.resolve('not-owner');
      held.delete(grant.key.full);
      wakeAll(grant.key.full);
      return Promise.resolve('released');
    },
    waitFor(key: Key, signal: AbortSignal): Promise<void> {
      return parkUntilWoken(key.full, signal, () => isHeld(key.full));
    },
    peek(key: Key): MemoryEntry | undefined {
      const entry = held.get(key.full);
      if (entry !== undefined) return { ...entry };
      const pool = pools.get(key.full);
      if (pool !== undefined) {
        const [owner] = pool.holders.keys();
        return owner === undefined
          ? undefined
          : {
              owner,
              fence: newest([...pool.holders.values()].map(hold => hold.fence)),
              permits: pool.inUse,
              holders: pool.holders.size,
            };
      }
      const state = shareds.get(key.full);
      if (state?.writer !== undefined) return { owner: state.writer.token, fence: state.writer.fence, mode: 'write' };
      const [reader] = state?.readers.keys() ?? [];
      if (state === undefined || reader === undefined) return undefined;
      return { owner: reader, fence: newest(state.readers.values()), mode: 'read', holders: state.readers.size };
    },
  };
}

function newest(fences: Iterable<bigint>): bigint {
  let latest = 0n;
  for (const fence of fences) if (fence > latest) latest = fence;
  return latest;
}
