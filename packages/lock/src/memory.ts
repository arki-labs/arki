/**
 * In-process hold store: mutex, counting semaphore and read/write locks.
 * Portable: no `node:*`, no timers.
 *
 * Waiting callers queue per key and the lock is handed over, not fought for. A caller
 * registers a waiter (`waiter(...)`) after its first refusal and keeps its place until it
 * gets the lock or stops waiting. A release reserves the lock for the waiter at the head and
 * wakes only that one; its next attempt (`req.waiter`) turns the reservation into a hold.
 * Nobody else can take a reserved lock, so a newcomer cannot barge in between the wake-up
 * and the retry, and a release costs O(woken), not O(waiting). A waiter that stops waiting
 * while it holds a reservation passes it on.
 *
 * - Mutex: a release wakes exactly one waiter, the one that began to wait first, so
 *   contended work runs FIFO.
 * - Semaphore (`permits`): a key holds up to `limit` permits, each hold takes `weight`.
 *   A release reserves permits for the queued waiters that now fit, in queue order, and
 *   wakes just those. There is no head-of-line blocking: a heavy waiter that does not fit
 *   is passed by lighter ones behind it. The limit is remembered only while the key has a
 *   holder or a reservation; a different limit while held is a `config` error.
 * - Read/write (`shared`): readers overlap, a writer excludes readers and writers, and there
 *   is no upgrade or downgrade. Writer preference: while a writer waits, new readers are
 *   refused and queued readers stay queued. Once the readers are out, a release hands the key
 *   to the first waiting writer; with no writer waiting, it admits every queued reader.
 *   Trade-off: a caller that holds a read lock and reads the same key again (a nested read)
 *   deadlocks while a writer waits, because the writer waits for the first read and the
 *   second read waits for the writer. Do not nest reads on one key.
 *
 * `waitFor` is the plain wake-up for callers without a waiter: it resolves once the key is free.
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
import { isPermitCount } from './types.js';

/** What `memoryStore` promises. */
export const memoryGuarantees = {
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

export type MemoryGuarantees = typeof memoryGuarantees;

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
  /** Resolves when the key is free (any primitive), or when `signal` aborts. */
  waitFor(key: Key, signal: AbortSignal): Promise<void>;
  /** A mutex waiter: queued now, handed the lock by a release. */
  waiter(key: Key): Waiter;
  readonly permits: PermitOps & { waiter(key: Key, weight: number): Waiter };
  readonly shared: SharedOps & { waiter(key: Key, mode: 'read' | 'write'): Waiter };
  /** The current holder of `key`, if any. A lock reserved for a woken waiter has none yet. For tests and debugging. */
  peek(key: Key): MemoryEntry | undefined;
};

/** An attempt the store refused. (A variable, because `Promise.resolve(undefined)` is rewritten to `Promise<void>` by lint.) */
const refused: Promise<Grant | undefined> = Promise.resolve(new Map<string, Grant>().get(''));
const released: Promise<ReleaseOutcome> = Promise.resolve('released');
const notOwner: Promise<ReleaseOutcome> = Promise.resolve('not-owner');

/** Which wait a waiter is: a mutex, a semaphore, or one side of a read/write key. */
type WaitKind = 'mutex' | 'permits' | 'read' | 'write';

type Hold = { readonly owner: string; readonly fence: bigint };

type MutexState = { holder: Hold | undefined; reserved: Waiter | undefined };

type Pool = {
  readonly limit: number;
  /** Held and reserved permits. */
  inUse: number;
  /** Permits reserved for woken waiters that have not taken them yet. */
  reserved: number;
  /** In acquisition order. */
  readonly holders: Map<string, { readonly weight: number; readonly fence: bigint }>;
};

type Shared = {
  /** In acquisition order. */
  readonly readers: Map<string, bigint>;
  writer: Hold | undefined;
  /** Woken readers that have not taken their hold yet. */
  reservedReaders: number;
  /** A woken writer that has not taken its hold yet. */
  reservedWriter: Waiter | undefined;
};

export function memoryStore(): MemoryStore {
  const mutexes = new Map<string, MutexState>();
  const pools = new Map<string, Pool>();
  const shareds = new Map<string, Shared>();
  /** Queued mutex, semaphore and writer waiters, per key. */
  const lines = new Map<string, Line>();
  /** Queued readers, per key: a separate line, so finding the first writer never walks past readers. */
  const readerLines = new Map<string, Line>();
  /** Plain `waitFor` callers, per key. */
  const watchers = new Map<string, Set<() => void>>();
  let lastFence = 0n;

  function nextFence(): bigint {
    lastFence += 1n;
    return lastFence;
  }

  type Line = { head: Session | undefined; tail: Session | undefined; size: number };

  /** One caller's wait (see the file header). A doubly linked node, so leaving the middle of a line is O(1). */
  class Session implements Waiter {
    readonly full: string;
    readonly kind: WaitKind;
    readonly weight: number;
    state: 'idle' | 'queued' | 'reserved' = 'idle';
    closed = false;
    prev: Session | undefined;
    next: Session | undefined;
    /** Resolves the pending `waitFor`, if any. */
    wake: (() => void) | undefined;

    constructor(full: string, kind: WaitKind, weight: number) {
      this.full = full;
      this.kind = kind;
      this.weight = weight;
    }

    waitFor(signal: AbortSignal): Promise<void> {
      // Idle (nothing to wait for), reserved (the lock is ours) or aborted: go at once.
      if (this.state !== 'queued' || signal.aborted) return Promise.resolve();
      return new Promise<void>(resolve => {
        const onAbort = (): void => {
          if (this.wake === wake) this.wake = undefined;
          resolve();
        };
        const wake = (): void => {
          this.wake = undefined;
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        this.wake = wake;
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.wake?.();
      if (this.state === 'queued') {
        leave(this);
        // A writer that leaves may let readers in.
        dispatch(this);
      } else if (this.state === 'reserved') {
        unreserve(this);
        dispatch(this);
      }
    }
  }

  function lineMap(session: Session): Map<string, Line> {
    return session.kind === 'read' ? readerLines : lines;
  }

  function join(session: Session): void {
    const map = lineMap(session);
    let line = map.get(session.full);
    if (line === undefined) {
      line = { head: undefined, tail: undefined, size: 0 };
      map.set(session.full, line);
    }
    session.prev = line.tail;
    session.next = undefined;
    if (line.tail === undefined) line.head = session;
    else line.tail.next = session;
    line.tail = session;
    line.size += 1;
    session.state = 'queued';
  }

  function leave(session: Session): void {
    const map = lineMap(session);
    const line = map.get(session.full);
    session.state = 'idle';
    if (line === undefined) return;
    if (session.prev === undefined) line.head = session.next;
    else session.prev.next = session.next;
    if (session.next === undefined) line.tail = session.prev;
    else session.next.prev = session.prev;
    session.prev = undefined;
    session.next = undefined;
    line.size -= 1;
    if (line.size === 0) map.delete(session.full);
  }

  /** Take a queued waiter out of its line, mark the lock reserved for it, and wake it. */
  function handTo(session: Session): void {
    leave(session);
    session.state = 'reserved';
    session.wake?.();
  }

  /** A waiter gives back a reservation it never took. */
  function unreserve(session: Session): void {
    session.state = 'idle';
    if (session.kind === 'mutex') {
      const state = mutexes.get(session.full);
      if (state?.reserved === session) state.reserved = undefined;
    } else if (session.kind === 'permits') {
      const pool = pools.get(session.full);
      if (pool === undefined) return;
      pool.inUse -= session.weight;
      pool.reserved -= session.weight;
    } else {
      const state = shareds.get(session.full);
      if (state === undefined) return;
      if (session.kind === 'read') state.reservedReaders -= 1;
      else if (state.reservedWriter === session) state.reservedWriter = undefined;
    }
  }

  function dispatch(session: Session): void {
    if (session.kind === 'mutex') dispatchMutex(session.full);
    else if (session.kind === 'permits') dispatchPermits(session.full);
    else dispatchShared(session.full);
  }

  /** The attempt's own waiter, when it comes to take the reservation made for it. */
  function redeeming(req: AcquireRequest, full: string, kind: WaitKind, weight: number): Session | undefined {
    const waiter = req.waiter;
    return waiter instanceof Session &&
      waiter.state === 'reserved' &&
      waiter.full === full &&
      waiter.kind === kind &&
      waiter.weight === weight
      ? waiter
      : undefined;
  }

  /** A refused attempt by a waiter that is not in line yet (it was free when it registered) joins the line now. */
  function queueRefused(req: AcquireRequest, full: string, kind: WaitKind, weight: number): Promise<Grant | undefined> {
    const waiter = req.waiter;
    if (
      waiter instanceof Session &&
      waiter.state === 'idle' &&
      !waiter.closed &&
      waiter.full === full &&
      waiter.kind === kind &&
      waiter.weight === weight
    ) {
      join(waiter);
    }
    return refused;
  }

  function wakeWatchers(full: string): void {
    const waiting = watchers.get(full);
    if (waiting === undefined) return;
    watchers.delete(full);
    for (const wake of waiting) wake();
  }

  // ---- mutex ----

  function dispatchMutex(full: string): void {
    const state = mutexes.get(full);
    if (state?.holder !== undefined || state?.reserved !== undefined) return;
    const head = lines.get(full)?.head;
    if (head === undefined) {
      mutexes.delete(full);
      wakeWatchers(full);
      return;
    }
    const target = state ?? { holder: undefined, reserved: undefined };
    target.reserved = head;
    mutexes.set(full, target);
    handTo(head);
  }

  // ---- permits ----

  function dispatchPermits(full: string): void {
    const pool = pools.get(full);
    if (pool !== undefined) {
      // Grant as we go, in queue order, while permits are left. A waiter that does not fit keeps its place.
      let session = lines.get(full)?.head;
      while (session !== undefined && pool.inUse < pool.limit) {
        const next = session.next;
        if (pool.inUse + session.weight <= pool.limit) {
          pool.inUse += session.weight;
          pool.reserved += session.weight;
          handTo(session);
        }
        session = next;
      }
      if (pool.holders.size > 0 || pool.reserved > 0) return;
      pools.delete(full);
    }
    wakeWatchers(full);
  }

  const permits: MemoryStore['permits'] = {
    acquire(key: Key, req: PermitRequest): Promise<Grant | undefined> {
      const { limit, weight } = req;
      // PermitOps is public: a caller that skips the manager must not take a negative or fractional hold.
      if (!isPermitCount(limit) || !isPermitCount(weight)) {
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
      const full = key.full;
      const pool = pools.get(full);
      if (pool !== undefined && pool.limit !== limit) {
        return Promise.reject(
          new LockError({
            code: 'config',
            message: `the semaphore is held with limit ${pool.limit}, not ${limit}`,
            remediation: 'Declare one limit per semaphore key; a new limit is accepted once no hold is left.',
          }),
        );
      }
      const own = pool === undefined ? undefined : redeeming(req, full, 'permits', weight);
      const target = pool ?? { limit, inUse: 0, reserved: 0, holders: new Map() };
      if (own !== undefined) {
        // The permits were counted when they were reserved.
        own.state = 'idle';
        target.reserved -= weight;
      } else if (target.inUse + weight > limit) {
        return queueRefused(req, full, 'permits', weight);
      } else {
        target.inUse += weight;
      }
      const fence = nextFence();
      target.holders.set(req.token, { weight, fence });
      pools.set(full, target);
      return Promise.resolve({ key, token: req.token, fence });
    },
    release(grant: Grant): Promise<ReleaseOutcome> {
      const pool = pools.get(grant.key.full);
      const hold = pool?.holders.get(grant.token);
      if (pool === undefined || hold === undefined) return notOwner;
      pool.holders.delete(grant.token);
      pool.inUse -= hold.weight;
      dispatchPermits(grant.key.full);
      return released;
    },
    waiter(key: Key, weight: number): Waiter {
      const session = new Session(key.full, 'permits', weight);
      const pool = pools.get(key.full);
      // No pool: the key is free, so the next attempt takes it (or, if someone got there first, joins the line).
      if (pool === undefined) return session;
      // Anyone queued who fits was served by the last release, so only this waiter can fit now.
      if (pool.inUse + weight <= pool.limit) {
        pool.inUse += weight;
        pool.reserved += weight;
        session.state = 'reserved';
      } else {
        join(session);
      }
      return session;
    },
  };

  // ---- read/write ----

  function dispatchShared(full: string): void {
    const state = shareds.get(full);
    if (state?.writer !== undefined || state?.reservedWriter !== undefined) return;
    const writer = lines.get(full)?.head;
    if (writer !== undefined) {
      // Writer preference: readers wait while a writer does; the writer goes once the readers are out.
      if (state !== undefined && (state.readers.size > 0 || state.reservedReaders > 0)) return;
      const target = state ?? newShared();
      target.reservedWriter = writer;
      shareds.set(full, target);
      handTo(writer);
      return;
    }
    let reader = readerLines.get(full)?.head;
    if (reader !== undefined) {
      const target = state ?? newShared();
      shareds.set(full, target);
      while (reader !== undefined) {
        const next: Session | undefined = reader.next;
        target.reservedReaders += 1;
        handTo(reader);
        reader = next;
      }
      return;
    }
    if (state !== undefined && (state.readers.size > 0 || state.reservedReaders > 0)) return;
    shareds.delete(full);
    wakeWatchers(full);
  }

  function newShared(): Shared {
    return { readers: new Map(), writer: undefined, reservedReaders: 0, reservedWriter: undefined };
  }

  /** Whether a new `mode` hold is refused now. A read is refused while any writer holds, is reserved or waits. */
  function sharedBlocked(state: Shared | undefined, full: string, mode: 'read' | 'write'): boolean {
    if (state?.writer !== undefined || state?.reservedWriter !== undefined) return true;
    if (mode === 'read') return lines.has(full);
    return state !== undefined && (state.readers.size > 0 || state.reservedReaders > 0);
  }

  const shared: MemoryStore['shared'] = {
    acquire(key: Key, req: SharedRequest): Promise<Grant | undefined> {
      const full = key.full;
      const state = shareds.get(full);
      const own = state === undefined ? undefined : redeeming(req, full, req.mode, 1);
      if (own !== undefined && state !== undefined) {
        own.state = 'idle';
        if (req.mode === 'read') state.reservedReaders -= 1;
        else state.reservedWriter = undefined;
      } else if (sharedBlocked(state, full, req.mode)) {
        return queueRefused(req, full, req.mode, 1);
      }
      const target = state ?? newShared();
      const fence = nextFence();
      if (req.mode === 'read') target.readers.set(req.token, fence);
      else target.writer = { owner: req.token, fence };
      shareds.set(full, target);
      return Promise.resolve({ key, token: req.token, fence });
    },
    release(grant: Grant): Promise<ReleaseOutcome> {
      const state = shareds.get(grant.key.full);
      if (state === undefined) return notOwner;
      if (state.writer?.owner === grant.token) state.writer = undefined;
      else if (!state.readers.delete(grant.token)) return notOwner;
      dispatchShared(grant.key.full);
      return released;
    },
    waiter(key: Key, mode: 'read' | 'write'): Waiter {
      const full = key.full;
      const session = new Session(full, mode, 1);
      const state = shareds.get(full);
      if (sharedBlocked(state, full, mode)) {
        join(session);
        return session;
      }
      // Free for this mode now: reserve it, so a waiting writer is counted from the start.
      const target = state ?? newShared();
      if (mode === 'read') target.reservedReaders += 1;
      else target.reservedWriter = session;
      shareds.set(full, target);
      session.state = 'reserved';
      return session;
    },
  };

  const isFree = (full: string): boolean => {
    const mutex = mutexes.get(full);
    if (mutex?.holder !== undefined || mutex?.reserved !== undefined || pools.has(full)) return false;
    const state = shareds.get(full);
    return state === undefined || !sharedBlocked(state, full, 'write');
  };

  return {
    name: 'memory',
    guarantees: memoryGuarantees,
    permits,
    shared,
    acquire(key: Key, req: AcquireRequest): Promise<Grant | undefined> {
      const full = key.full;
      const state = mutexes.get(full);
      if (state?.reserved !== undefined) {
        const own = redeeming(req, full, 'mutex', 1);
        if (own === undefined || state.reserved !== own) return queueRefused(req, full, 'mutex', 1);
        own.state = 'idle';
        state.reserved = undefined;
      } else if (state?.holder !== undefined) {
        return queueRefused(req, full, 'mutex', 1);
      }
      const fence = nextFence();
      const target = state ?? { holder: undefined, reserved: undefined };
      target.holder = { owner: req.token, fence };
      mutexes.set(full, target);
      return Promise.resolve({ key, token: req.token, fence });
    },
    release(grant: Grant): Promise<ReleaseOutcome> {
      const state = mutexes.get(grant.key.full);
      if (state?.holder?.owner !== grant.token) return notOwner;
      state.holder = undefined;
      dispatchMutex(grant.key.full);
      return released;
    },
    waiter(key: Key): Waiter {
      const session = new Session(key.full, 'mutex', 1);
      const state = mutexes.get(key.full);
      if (state?.holder !== undefined || state?.reserved !== undefined) {
        join(session);
        return session;
      }
      // Freed since the refusal. Nobody is queued on a free key, so this waiter is first.
      mutexes.set(key.full, { holder: undefined, reserved: session });
      session.state = 'reserved';
      return session;
    },
    waitFor(key: Key, signal: AbortSignal): Promise<void> {
      const full = key.full;
      if (isFree(full) || signal.aborted) return Promise.resolve();
      return new Promise<void>(resolve => {
        let waiting = watchers.get(full);
        if (waiting === undefined) {
          waiting = new Set();
          watchers.set(full, waiting);
        }
        const set = waiting;
        const wake = (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          set.delete(wake);
          if (set.size === 0 && watchers.get(full) === set) watchers.delete(full);
          resolve();
        };
        set.add(wake);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    peek(key: Key): MemoryEntry | undefined {
      const holder = mutexes.get(key.full)?.holder;
      if (holder !== undefined) return { owner: holder.owner, fence: holder.fence };
      const pool = pools.get(key.full);
      if (pool !== undefined) {
        const [owner] = pool.holders.keys();
        return owner === undefined
          ? undefined
          : {
              owner,
              fence: newest([...pool.holders.values()].map(hold => hold.fence)),
              permits: pool.inUse - pool.reserved,
              holders: pool.holders.size,
            };
      }
      const state = shareds.get(key.full);
      if (state?.writer !== undefined) return { owner: state.writer.owner, fence: state.writer.fence, mode: 'write' };
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
