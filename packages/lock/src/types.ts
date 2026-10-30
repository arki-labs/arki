import type { FailureIn } from '@arki/failure';
/**
 * The public vocabulary of `@arki/lock`. Every shape is written once: data
 * shapes are Zod schemas whose types are inferred, handle shapes are derived
 * from the store's `guarantees`, so a missing capability is a missing method.
 */

import type { LockError, LockOperationFailure, LockRunFailure, ReleaseFailure, StoreFailure } from './errors.js';
import type { LockFence, LockToken } from './identities.js';
import type { Scheduler } from './scheduler.js';

/** Canonical spellings shared by types and their optional Zod schemas. */
export const DURATION_UNITS = ['ms', 's', 'm', 'h'] as const;
export const GUARANTEE_VALUES = {
  kind: ['hold', 'lease'],
  scope: ['process', 'host', 'cluster'],
  wait: ['native', 'wake', 'poll', 'none'],
  fence: ['durable', 'best-effort', 'process'],
  releasedOnCrash: ['immediate', 'after-ttl'],
  clock: ['store', 'host', 'none'],
  runtime: ['node', 'bun', 'deno', 'browser', 'hermes'],
  releasedBy: ['transaction'],
} as const;

/** Milliseconds or a duration with an explicit supported unit. */
export type Duration = number | `${number}${(typeof DURATION_UNITS)[number]}`;
export const MAX_NAME_BYTES = 512;
/** Postgres stores permit counts as signed integers. */
export const MAX_PERMITS = 2_147_483_647;
export type SemaphoreConfig = { limit: number };

/** Preconditions on already typed permit counts; external input uses the source schema. */
export function isPermitCount(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PERMITS;
}

type GuaranteeValues = typeof GUARANTEE_VALUES;
/** Capabilities determine which methods exist on the public handle. */
export type Guarantees = Readonly<{
  [K in Exclude<keyof GuaranteeValues, 'runtime' | 'fence' | 'releasedBy'>]: GuaranteeValues[K][number];
} & {
  shared: boolean;
  permits: boolean;
  fence: GuaranteeValues['fence'][number] | false;
  poolerSafe: boolean;
  releasedBy?: GuaranteeValues['releasedBy'][number];
  writerPreference?: boolean;
  runtimes: readonly GuaranteeValues['runtime'][number][];
}>;

/** A canonical resource key; createKey preserves its persisted encoding. */
export type Key = Readonly<{ namespace: string; name: string; full: import('./identities.js').LockKey }>;
/** Successful store ownership; conn is an explicitly foreign private handle. */
export type Grant = Readonly<{
  key: Key;
  token: LockToken;
  fence?: LockFence;
  expiresAt?: number;
  conn?: unknown;
  lost?: Promise<LockError>;
}>;

// ---------------------------------------------------------------------------
// The store port
// ---------------------------------------------------------------------------

export const RELEASE_OUTCOMES = ['released', 'not-owner', 'unknown'] as const;
export type ReleaseOutcome = (typeof RELEASE_OUTCOMES)[number];

/** One atomic attempt on a mutex key. */
export type AcquireRequest = {
  /** Fresh per attempt, so a late grant can only give back its own lock. */
  readonly token: LockToken;
  /** Lease stores: how long the lock lasts without renewal. */
  readonly ttlMs?: number;
  /** Stores with `wait: 'native'`: block up to this long inside the store. Absent = one attempt. */
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
  /**
   * The caller's wait (from `waiter()`), on its attempts after the first refusal. A store that
   * hands a freed lock straight to a waiter grants it only to that waiter's attempt.
   */
  readonly waiter?: Waiter;
};

/** One attempt at `weight` of `limit` permits. The store persists `limit` and rejects a conflicting one with `config`. */
export type PermitRequest = AcquireRequest & { readonly limit: number; readonly weight: number };

/** One attempt at a read or write hold. */
export const SHARED_MODES = ['read', 'write'] as const;
export type SharedRequest = AcquireRequest & { readonly mode: (typeof SHARED_MODES)[number] };

/**
 * One caller's wait on a key, from its first refused attempt until its acquire loop ends
 * (acquired, timed out or aborted). See {@link PermitOps.waiter} and {@link SharedOps.waiter}.
 */
export type Waiter<F = StoreFailure> = {
  /**
   * Resolves when the key may have changed in a way this caller cares about, or when `signal`
   * aborts. It must also resolve at once when the caller could already fit, so a release that
   * happened between the refusal and this call is not missed.
   */
  waitFor(signal: AbortSignal): Promise<void | F>;
  /** The caller stopped waiting. Idempotent. */
  close(): void;
};

/** Semaphore protocol of a store with `guarantees.permits`. */
export type PermitOps<F = StoreFailure> = {
  acquire(key: Key, req: PermitRequest): Promise<Grant | undefined | F>;
  release(grant: Grant): Promise<ReleaseOutcome | F>;
  extend?(grant: Grant, ttlMs: number): Promise<boolean | F>;
  /**
   * Optional. The manager calls it once per waiting caller, after the caller's first refused
   * attempt, and prefers it to `Store.waitFor`. The waiter's condition is "`weight` permits do
   * not fit now", which lets a store wake only the waiters that can fit and never miss a permit
   * freed between a refusal and the wait. `close()` is called after the caller's last attempt.
   */
  waiter?(key: Key, weight: number): Waiter<F>;
};

/** Read/write protocol of a store with `guarantees.shared`. */
export type SharedOps<F = StoreFailure> = {
  acquire(key: Key, req: SharedRequest): Promise<Grant | undefined | F>;
  release(grant: Grant): Promise<ReleaseOutcome | F>;
  extend?(grant: Grant, ttlMs: number): Promise<boolean | F>;
  /**
   * Optional, for writer preference. The manager calls it once per waiting caller, after the
   * caller's first refused attempt, and prefers it to `Store.waitFor`. A store that counts the
   * writers it returns here can refuse new readers while one waits. The waiter stays registered
   * until `close()`, which the manager calls only after the caller's last attempt has settled:
   * that closes the gap between a wake-up and the woken writer's next attempt. Remote stores in
   * v1 do not implement it.
   */
  waiter?(key: Key, mode: SharedRequest['mode']): Waiter<F>;
};

/** A lease store's lease length is configured once, on the store (`pgLease(db, { ttl })`); the manager reads it. */
export type LeaseTtl<G extends Guarantees> = G['kind'] extends 'lease' ? { readonly ttlMs: number } : unknown;

type StoreBase<G extends Guarantees, F> = {
  readonly name: string;
  readonly guarantees: G;
  /** One atomic attempt. `undefined` = held by someone else. */
  acquire(key: Key, req: AcquireRequest): Promise<Grant | undefined | F>;
  /** Owner-checked. */
  release(grant: Grant): Promise<ReleaseOutcome | F>;
  /** Lease stores. `false` = the lease is gone; it is never revived. */
  extend?(grant: Grant, ttlMs: number): Promise<boolean | F>;
  /** Optional wake-up hook. Without it the core backs off with full jitter, 50 ms to 1 s. */
  waitFor?(key: Key, signal: AbortSignal): Promise<void | F>;
  /** Optional, like {@link PermitOps.waiter} for a mutex. The manager prefers it to `waitFor`. */
  waiter?(key: Key): Waiter<F>;
  readonly permits?: PermitOps<F>;
  readonly shared?: SharedOps<F>;
  dispose?(): Promise<void | F>;
};

export type Store<G extends Guarantees = Guarantees, F = StoreFailure> = StoreBase<G, F> & LeaseTtl<G>;

// ---------------------------------------------------------------------------
// Handles, derived from the store's guarantees
// ---------------------------------------------------------------------------

/** `bigint` when the store hands out fences, else `undefined`. */
type FenceValue<F> = F extends false ? undefined : LockFence;
export type FenceOf<S extends Store> = FenceValue<S['guarantees']['fence']>;

/** The only things a callback receives. */
export type LockContext<S extends Store> = {
  /** Aborts when the lock is known lost (or the caller's signal aborts). */
  readonly signal: AbortSignal;
  readonly fence: FenceOf<S>;
  readonly key: Key;
};

type CallOptions = {
  /** Every store kind: delay the release until this long after acquisition (closes clock-skew double runs of short jobs). */
  readonly holdAtLeast?: Duration;
  /** Default `'abort'`. */
  readonly onLost?: 'abort' | 'ignore';
};

/** Options only a semaphore handle takes. */
export type WeightOption = {
  /** Permits to take. A positive integer up to the limit. */
  readonly weight?: number;
};

/** Options of the verbs that never wait. `Extra` carries options of one handle kind, such as {@link WeightOption}. */
export type TryOptions<Extra = unknown> = CallOptions & Extra & { readonly signal?: AbortSignal };

/** A wait bound. Optional on process-scope stores; on any other scope `wait` or `signal` is required. */
type WaitBound<S extends Store> = S['guarantees']['scope'] extends 'process'
  ? { readonly wait?: Duration; readonly signal?: AbortSignal }
  : | { readonly wait: Duration; readonly signal?: AbortSignal }
    | { readonly wait?: Duration; readonly signal: AbortSignal };

/** Options of the verbs that wait (`run`, `acquire`). */
export type RunOptions<S extends Store, Extra = unknown> = CallOptions & Extra & WaitBound<S>;

/** `run(fn)` needs no options on a process-scope store; elsewhere they are required. */
export type RunArgs<S extends Store, Extra = unknown> =
  Record<never, never> extends RunOptions<S, Extra> ? [opts?: RunOptions<S, Extra>] : [opts: RunOptions<S, Extra>];

type IsLease<S extends Store> = S['guarantees']['kind'] extends 'lease' ? true : false;

type GuardBase<S extends Store> = {
  readonly key: Key;
  /** Aborted when the lock is known lost. */
  readonly signal: AbortSignal;
  /** False after release, loss, or once the local deadline passed, even before any timer fired. */
  readonly held: boolean;
  readonly fence: FenceOf<S>;
  /** Store time, ms. Lease stores only. */
  readonly expiresAt: IsLease<S> extends true ? number : undefined;
  /** Lease stores only; `never` on hold stores. */
  readonly extend: IsLease<S> extends true ? () => Promise<void | LockOperationFailure> : never;
};

/** Absent when the store's lock ends with the caller's transaction (`releasedBy: 'transaction'`). */
type GuardRelease = {
  /** Idempotent and owner-checked. Rejects with `LockError{code:'release'}` on failure or an `unknown` outcome. */
  release(): Promise<void | ReleaseFailure>;
  [Symbol.asyncDispose](): Promise<void>;
};

/** An acquired lock. */
export type Guard<S extends Store> = GuardBase<S> &
  (S['guarantees']['releasedBy'] extends 'transaction' ? unknown : GuardRelease);

/** The four verbs every lock handle has. `Extra` carries the options of one handle kind. */
export type LockVerbs<S extends Store, Extra = unknown> = {
  /** One atomic attempt. The value of `fn`, or {@link LockHeld} when the lock is busy: contention is a value, never an error. */
  tryRun<T>(fn: (ctx: LockContext<S>) => T | Promise<T>, opts?: TryOptions<Extra>): Promise<Awaited<T> | LockRunFailure>;
  /** Waits up to `wait`, or until `signal` aborts. {@link LockHeld} when the lock is still busy after the wait; throws `aborted`. */
  run<T>(fn: (ctx: LockContext<S>) => T | Promise<T>, ...opts: RunArgs<S, Extra>): Promise<Awaited<T> | LockRunFailure>;
  /** Waits like `run`. You release the guard yourself. */
  acquire(...opts: RunArgs<S, Extra>): Promise<Guard<S> | LockRunFailure>;
  /** One attempt, like `tryRun`. You release the guard yourself. */
  tryAcquire(opts?: TryOptions<Extra>): Promise<Guard<S> | LockRunFailure>;
};

/** Abort = step down and stop campaigning. */
export type LeadOptions = { readonly signal?: AbortSignal };

/** Leader election. Only on lease stores. */
export type LeaderOps<S extends Store> = {
  /** Settles when `opts.signal` aborts. */
  lead<T>(fn: (ctx: LockContext<S>) => T | Promise<T>, opts?: LeadOptions): Promise<void | FailureIn<Awaited<T>> | LockOperationFailure>;
};

export type MutexHandle<S extends Store> = LockVerbs<S> & (IsLease<S> extends true ? LeaderOps<S> : unknown);
/** Only a semaphore takes `weight`. */
export type SemaphoreHandle<S extends Store> = LockVerbs<S, WeightOption>;
export type ReadWriteHandle<S extends Store> = {
  readonly read: LockVerbs<S>;
  readonly write: LockVerbs<S>;
};

/** Names of the counters `Locks.counters` exposes (for tests). */
export const LOCK_COUNTER_NAMES = ['releaseErrors', 'leadAcquired', 'leadLost'] as const;
export type LockCounters = Readonly<Record<(typeof LOCK_COUNTER_NAMES)[number], number>>;

/** What `createLocks` returns. `semaphore` and `readWrite` exist only when the store supports them. */
export type Locks<S extends Store> = {
  readonly store: S;
  /** The namespace every key of this manager lives in. */
  readonly namespace: string;
  readonly counters: LockCounters;
  mutex(key: string): MutexHandle<S>;
} & (S['guarantees']['permits'] extends true
  ? { semaphore(key: string, config: SemaphoreConfig): SemaphoreHandle<S> }
  : unknown) &
  (S['guarantees']['shared'] extends true ? { readWrite(key: string): ReadWriteHandle<S> } : unknown);

/**
 * The lock handle typed by what the store promises, not by the store itself: any store with
 * the same `guarantees` fits. `Locks<S>` of a concrete store is assignable to it, so it is the
 * type to publish as a service, and a test can provide one on another store (`testStore`).
 */
export type LocksFor<G extends Guarantees> = Locks<Store<G>>;

export type CreateLocksOptions<S extends Store> = {
  readonly store: S;
  readonly namespace: string;
  /** Default: global timers (unref'd where present) and `performance.now()`. */
  readonly scheduler?: Scheduler;
  /** Bounds every store call. Default `'10s'`. */
  readonly storeTimeout?: Duration;
  /** A release failed after a successful callback. `run` and `tryRun` still return the value. */
  readonly onReleaseError?: (error: ReleaseFailure) => unknown;
  /** Default false: raw keys stay out of logs and spans. */
  readonly logKeys?: boolean;
};

/** The signature `createLocks` has. Implemented in `locks.ts`. */
export type CreateLocks = <S extends Store>(options: CreateLocksOptions<S>) => Locks<S>;
