/**
 * The public vocabulary of `@arki/lock`. Every shape is written once: data
 * shapes are Zod schemas whose types are inferred, handle shapes are derived
 * from the store's `guarantees`, so a missing capability is a missing method.
 */
import { z } from 'zod';

import type { LockError } from './errors.js';
import type { Scheduler } from './scheduler.js';

// ---------------------------------------------------------------------------
// Schemas (the boundary) and the types inferred from them
// ---------------------------------------------------------------------------

/** A number of milliseconds, or a string with unit `ms`, `s`, `m` or `h`. No days or weeks on purpose. */
export const durationSchema = z.union([
  z.number().finite().nonnegative(),
  z.templateLiteral([z.number().nonnegative(), z.enum(['ms', 's', 'm', 'h'])]),
]);
export type Duration = z.infer<typeof durationSchema>;

const MAX_NAME_BYTES = 512;

/** A key or namespace part: non-empty, at most 512 UTF-8 bytes, no lone surrogates (they would encode alike). */
export const keyNameSchema = z
  .string()
  .min(1, 'must not be empty')
  .refine((value) => !/\p{Cs}/u.test(value), 'must not contain lone surrogates')
  .refine((value) => new TextEncoder().encode(value).length <= MAX_NAME_BYTES, `must be at most ${MAX_NAME_BYTES} bytes`);

/** A semaphore size: a positive integer. */
export const limitSchema = z.number().int().positive();
/** How many permits one hold takes: a positive integer. */
export const weightSchema = z.number().int().positive();
/** `storeTimeout` in milliseconds, at least 1. */
export const storeTimeoutSchema = z.number().finite().min(1);
/** What `semaphore(key, config)` takes. */
export const semaphoreConfigSchema = z.object({ limit: limitSchema });
export type SemaphoreConfig = z.infer<typeof semaphoreConfigSchema>;

/** What a store promises. The types of every handle derive from this. */
export const guaranteesSchema = z
  .object({
    kind: z.enum(['hold', 'lease']),
    scope: z.enum(['process', 'host', 'cluster']),
    /** How blocking waits are implemented. */
    wait: z.enum(['native', 'wake', 'poll', 'none']),
    /** `readWrite()` is available. */
    shared: z.boolean(),
    /** `semaphore()` is available. */
    permits: z.boolean(),
    fence: z.union([z.enum(['durable', 'best-effort', 'process']), z.literal(false)]),
    releasedOnCrash: z.enum(['immediate', 'after-ttl']),
    /** Whose clock decides expiry. */
    clock: z.enum(['store', 'none']),
    poolerSafe: z.boolean(),
    runtimes: z.array(z.enum(['node', 'bun', 'deno', 'browser', 'hermes'])).readonly(),
  })
  .readonly();
export type Guarantees = z.infer<typeof guaranteesSchema>;

/** Canonical, length-delimited, versioned key. Built by `createKey`; see `key.ts`. */
export const keySchema = z.object({ namespace: z.string(), name: z.string(), full: z.string() }).readonly();
export type Key = z.infer<typeof keySchema>;

/** What a store returns for a successful attempt. */
export const grantSchema = z
  .object({
    key: keySchema,
    token: z.string(),
    fence: z.bigint().optional(),
    /** Store time, ms. */
    expiresAt: z.number().optional(),
    /** Store-private state, such as a pinned connection. */
    conn: z.unknown().optional(),
  })
  .readonly();
export type Grant = z.infer<typeof grantSchema>;

// ---------------------------------------------------------------------------
// The store port
// ---------------------------------------------------------------------------

export type ReleaseOutcome = 'released' | 'not-owner' | 'unknown';

/** One atomic attempt on a mutex key. */
export type AcquireRequest = {
  /** Fresh per attempt, so a late grant can only give back its own lock. */
  readonly token: string;
  /** Lease stores: how long the lock lasts without renewal. */
  readonly ttlMs?: number;
  /** Stores with `wait: 'native'`: block up to this long inside the store. Absent = one attempt. */
  readonly waitMs?: number;
  readonly signal?: AbortSignal;
};

/** One attempt at `weight` of `limit` permits. The store persists `limit` and rejects a conflicting one with `config`. */
export type PermitRequest = AcquireRequest & { readonly limit: number; readonly weight: number };

/** One attempt at a read or write hold. */
export type SharedRequest = AcquireRequest & { readonly mode: 'read' | 'write' };

/** Semaphore protocol of a store with `guarantees.permits`. */
export type PermitOps = {
  acquire(key: Key, req: PermitRequest): Promise<Grant | undefined>;
  release(grant: Grant): Promise<ReleaseOutcome>;
  extend?(grant: Grant, ttlMs: number): Promise<boolean>;
};

/** Read/write protocol of a store with `guarantees.shared`. */
export type SharedOps = {
  acquire(key: Key, req: SharedRequest): Promise<Grant | undefined>;
  release(grant: Grant): Promise<ReleaseOutcome>;
  extend?(grant: Grant, ttlMs: number): Promise<boolean>;
};

/** A lease store's lease length is configured once, on the store (`pgLease(db, { ttl })`); the manager reads it. */
export type LeaseTtl<G extends Guarantees> = G['kind'] extends 'lease' ? { readonly ttlMs: number } : unknown;

type StoreBase<G extends Guarantees> = {
  readonly name: string;
  readonly guarantees: G;
  /** One atomic attempt. `undefined` = held by someone else. */
  acquire(key: Key, req: AcquireRequest): Promise<Grant | undefined>;
  /** Owner-checked. */
  release(grant: Grant): Promise<ReleaseOutcome>;
  /** Lease stores. `false` = the lease is gone; it is never revived. */
  extend?(grant: Grant, ttlMs: number): Promise<boolean>;
  /** Optional wake-up hook. Without it the core backs off with full jitter, 50 ms to 1 s. */
  waitFor?(key: Key, signal: AbortSignal): Promise<void>;
  readonly permits?: PermitOps;
  readonly shared?: SharedOps;
  dispose?(): Promise<void>;
};

export type Store<G extends Guarantees = Guarantees> = StoreBase<G> & LeaseTtl<G>;

// ---------------------------------------------------------------------------
// Handles, derived from the store's guarantees
// ---------------------------------------------------------------------------

/** `bigint` when the store hands out fences, else `undefined`. */
export type FenceOf<S extends Store> = S['guarantees']['fence'] extends false ? undefined : bigint;

/** `{ ran: true; value }` when the callback ran, `{ ran: false }` when the lock was held. */
export type LockRun<T> = { readonly ran: true; readonly value: T } | { readonly ran: false };

/** The only things a callback receives. */
export type LockContext<S extends Store> = {
  /** Aborts when the lock is known lost (or the caller's signal aborts). */
  readonly signal: AbortSignal;
  readonly fence: FenceOf<S>;
  readonly key: Key;
};

type CallOptions = {
  /** Semaphore handles only: permits to take. A positive integer up to the limit. */
  readonly weight?: number;
  /** Every store kind: delay the release until this long after acquisition (closes clock-skew double runs of short jobs). */
  readonly holdAtLeast?: Duration;
  /** Default `'abort'`. */
  readonly onLost?: 'abort' | 'ignore';
};

/** Options of the verbs that never wait. */
export type TryOptions = CallOptions & { readonly signal?: AbortSignal };

/** A wait bound. Optional on process-scope stores; on any other scope `wait` or `signal` is required. */
type WaitBound<S extends Store> = S['guarantees']['scope'] extends 'process'
  ? { readonly wait?: Duration; readonly signal?: AbortSignal }
  :
      | { readonly wait: Duration; readonly signal?: AbortSignal }
      | { readonly wait?: Duration; readonly signal: AbortSignal };

/** Options of the verbs that wait (`run`, `acquire`). */
export type RunOptions<S extends Store> = CallOptions & WaitBound<S>;

/** `run(fn)` needs no options on a process-scope store; elsewhere they are required. */
export type RunArgs<S extends Store> = Record<never, never> extends RunOptions<S> ? [opts?: RunOptions<S>] : [opts: RunOptions<S>];

type IsLease<S extends Store> = S['guarantees']['kind'] extends 'lease' ? true : false;

/** An acquired lock. */
export type Guard<S extends Store> = {
  readonly key: Key;
  /** Aborted when the lock is known lost. */
  readonly signal: AbortSignal;
  /** False after release, loss, or once the local deadline passed, even before any timer fired. */
  readonly held: boolean;
  readonly fence: FenceOf<S>;
  /** Store time, ms. Lease stores only. */
  readonly expiresAt: IsLease<S> extends true ? number : undefined;
  /** Lease stores only; `never` on hold stores. */
  readonly extend: IsLease<S> extends true ? () => Promise<void> : never;
  /** Idempotent and owner-checked. Rejects with `LockError{code:'release'}` on failure or an `unknown` outcome. */
  release(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

/** The four verbs every lock handle has. */
export type LockVerbs<S extends Store> = {
  /** One atomic attempt. Contention is a value, never an error. */
  tryRun<T>(fn: (ctx: LockContext<S>) => T | Promise<T>, opts?: TryOptions): Promise<LockRun<Awaited<T>>>;
  /** Waits up to `wait`, or until `signal` aborts; throws `held` / `aborted`. */
  run<T>(fn: (ctx: LockContext<S>) => T | Promise<T>, ...opts: RunArgs<S>): Promise<Awaited<T>>;
  acquire(...opts: RunArgs<S>): Promise<Guard<S>>;
  tryAcquire(opts?: TryOptions): Promise<Guard<S> | undefined>;
};

/** Abort = step down and stop campaigning. */
export type LeadOptions = { readonly signal?: AbortSignal };

/** Leader election. Only on lease stores. */
export type LeaderOps<S extends Store> = {
  /** Settles when `opts.signal` aborts. */
  lead(fn: (ctx: LockContext<S>) => unknown, opts?: LeadOptions): Promise<void>;
};

export type MutexHandle<S extends Store> = LockVerbs<S> & (IsLease<S> extends true ? LeaderOps<S> : unknown);
export type SemaphoreHandle<S extends Store> = LockVerbs<S>;
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
  readonly counters: LockCounters;
  mutex(key: string): MutexHandle<S>;
} & (S['guarantees']['permits'] extends true ? { semaphore(key: string, config: SemaphoreConfig): SemaphoreHandle<S> } : unknown) &
  (S['guarantees']['shared'] extends true ? { readWrite(key: string): ReadWriteHandle<S> } : unknown);

export type CreateLocksOptions<S extends Store> = {
  readonly store: S;
  readonly namespace: string;
  /** Default: global timers (unref'd where present) and `performance.now()`. */
  readonly scheduler?: Scheduler;
  /** Bounds every store call. Default `'10s'`. */
  readonly storeTimeout?: Duration;
  /** A release failed after a successful callback. `run` and `tryRun` still return the value. */
  readonly onReleaseError?: (error: LockError) => void;
  /** Default false: raw keys stay out of logs and spans. */
  readonly logKeys?: boolean;
};

/** The signature `createLocks` has. Implemented in `locks.ts`. */
export type CreateLocks = <S extends Store>(options: CreateLocksOptions<S>) => Locks<S>;
