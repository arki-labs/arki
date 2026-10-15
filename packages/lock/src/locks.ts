/**
 * The manager: turns a {@link Store}'s one-attempt protocol into `tryRun`,
 * `run`, `acquire` and `tryAcquire`. Owns the wait loop, the renewal loop, the
 * per-process queue in front of remote stores and the `lost` plumbing.
 *
 * Mutex, semaphore and read/write handles share one code path. Each binds a
 * {@link Protocol}: the store's own acquire/release/extend for a mutex, its
 * `permits` ops with `{ limit, weight }` for a semaphore, its `shared` ops with
 * `{ mode }` for read/write. Tokens, late-grant give-back, renewal, deadlines and
 * the per-process attempt gate are the same for all three.
 *
 * Everything below `createLocks` works on the plain `Store`. The gated public
 * types (`Locks<S>`, `Guard<S>`) are conditional on the store's guarantees,
 * which TypeScript cannot satisfy for a generic `S`. So `createLocks` is an
 * overload: the public signature promises `Locks<S>`, the implementation
 * returns the wide `LocksImpl` and TypeScript checks the two are compatible.
 */
import { getLogger } from '@arki/log';

import type { LockMethod } from './errors.js';
import type { Scheduler, SchedulerHandle } from './scheduler.js';
import type {
  AcquireRequest,
  CreateLocksOptions,
  Duration,
  Grant,
  Key,
  LockCounters,
  LockRun,
  Locks,
  PermitOps,
  ReleaseOutcome,
  SemaphoreConfig,
  SharedOps,
  Store,
  Waiter,
} from './types.js';
import { LockError } from './errors.js';
import { createKey } from './key.js';
import { lead } from './lead.js';
import { defaultScheduler } from './scheduler.js';
import { semaphoreConfigSchema, storeTimeoutSchema, weightSchema } from './types.js';
import { BACKOFF_MAX_MS, backoffDelay, parseDuration, raceSignal, withStoreTimeout } from './wait.js';

const log = getLogger('arki:lock');

/**
 * The shortest lease the manager accepts. Renewal runs every ttl/3, so a
 * shorter lease would renew faster than a store round trip can be trusted.
 */
export const MIN_LEASE_TTL_MS = 1000;
const DEFAULT_STORE_TIMEOUT: Duration = '10s';

// ---------------------------------------------------------------------------
// Wide internal shapes (the gated public types are conditional on `S`)
// ---------------------------------------------------------------------------

type CallOptions = {
  readonly wait?: Duration;
  readonly signal?: AbortSignal;
  readonly weight?: number;
  readonly holdAtLeast?: Duration;
  readonly onLost?: 'abort' | 'ignore';
};

type ContextImpl = { readonly signal: AbortSignal; readonly fence: bigint | undefined; readonly key: Key };

type GuardImpl = {
  readonly key: Key;
  readonly signal: AbortSignal;
  readonly held: boolean;
  readonly fence: bigint | undefined;
  readonly expiresAt: number | undefined;
  readonly extend?: () => Promise<void>;
  release(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

type HandleImpl = {
  tryRun<T>(fn: (ctx: ContextImpl) => T | Promise<T>, opts?: CallOptions): Promise<LockRun<Awaited<T>>>;
  run<T>(fn: (ctx: ContextImpl) => T | Promise<T>, opts?: CallOptions): Promise<Awaited<T>>;
  acquire(opts?: CallOptions): Promise<GuardImpl>;
  tryAcquire(opts?: CallOptions): Promise<GuardImpl | undefined>;
  /** Lease stores only. */
  lead?(fn: (ctx: ContextImpl) => unknown, opts?: { readonly signal?: AbortSignal }): Promise<void>;
};

/**
 * What the manager runs a handle on. The request a protocol receives is the plain
 * mutex request; a semaphore or read/write protocol adds its own fields before the store sees it.
 */
type Protocol = {
  acquire(key: Key, req: AcquireRequest): Promise<Grant | undefined>;
  release(grant: Grant): Promise<ReleaseOutcome>;
  extend?(grant: Grant, ttlMs: number): Promise<boolean>;
  /** A store-aware wait (writer preference, permits that fit). Absent or `undefined`: wait on `Store.waitFor`. */
  waiter?(key: Key): Waiter | undefined;
};

type ReadWriteImpl = { readonly read: HandleImpl; readonly write: HandleImpl };

type LocksImpl = {
  readonly store: Store;
  readonly counters: LockCounters;
  mutex(key: string): HandleImpl;
  semaphore?(key: string, config: SemaphoreConfig): HandleImpl;
  readWrite?(key: string): ReadWriteImpl;
};

/** A guard plus what only the manager may see. */
type Held = {
  readonly guard: GuardImpl;
  lostError(): LockError | undefined;
  /** Set when the grant arrived with less than ttl/3 left: renew once before use. */
  readonly renewNow?: () => Promise<void>;
};

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function noop(): void {
  // A late result is handled elsewhere; this only keeps it from being reported as unhandled.
}

const neverSettlesVoid: Promise<void> = new Promise<void>(() => {
  // Never settles: used to drop out of a race.
});

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function asStoreError(error: unknown, method: LockMethod): LockError {
  if (error instanceof LockError) return error;
  return new LockError({
    code: 'store',
    message: `store ${method} failed`,
    remediation: 'Check the store. Ownership of the lock is unknown.',
    cause: error,
    outcome: 'unknown',
    method,
  });
}

function asReleaseError(error: unknown): LockError {
  if (error instanceof LockError && error.code === 'release') return error;
  return new LockError({
    code: 'release',
    message: 'the lock could not be released',
    remediation: 'The lock frees itself when its lease or connection ends. Check the store.',
    cause: error,
    method: 'release',
  });
}

/** Lock-side errors ride on the callback's own error, as `using` does. */
function addSuppressed(error: unknown, extra: readonly Error[]): void {
  if (!(error instanceof Error) || extra.length === 0) return;
  const existing = error instanceof LockError ? (error.suppressed ?? []) : [];
  Object.defineProperty(error, 'suppressed', {
    value: [...existing, ...extra],
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

function configError(message: string, remediation: string): LockError {
  return new LockError({ code: 'config', message, remediation });
}

function heldError(): LockError {
  return new LockError({
    code: 'held',
    message: 'the lock was not acquired within the wait',
    remediation: 'Raise wait, or treat the key as busy.',
  });
}

// ---------------------------------------------------------------------------
// createLocks
// ---------------------------------------------------------------------------

export function createLocks<S extends Store>(options: CreateLocksOptions<S>): Locks<S>;
export function createLocks(options: CreateLocksOptions<Store>): LocksImpl | Locks<Store> {
  const { store, namespace, onReleaseError } = options;
  const scheduler: Scheduler = options.scheduler ?? defaultScheduler;
  const storeTimeoutMs = parseDuration(options.storeTimeout ?? DEFAULT_STORE_TIMEOUT);
  if (!storeTimeoutSchema.safeParse(storeTimeoutMs).success) {
    throw new LockError({
      code: 'config',
      message: 'storeTimeout must be at least 1 ms',
      remediation: "Pass a duration such as '10s'.",
    });
  }
  const logKeys = options.logKeys === true;
  const leased = store.guarantees.kind === 'lease';
  // The lease length is the store's own setting; the manager never imposes one.
  const leaseMs = 'ttlMs' in store && typeof store.ttlMs === 'number' ? store.ttlMs : 0;
  if (leased && !(leaseMs >= MIN_LEASE_TTL_MS)) {
    throw new LockError({
      code: 'config',
      message: `lease ttl ${leaseMs} ms is below the renewal floor of ${MIN_LEASE_TTL_MS} ms`,
      remediation: `Configure the lease store with a ttl of at least ${MIN_LEASE_TTL_MS} ms.`,
    });
  }
  const permitOps = store.guarantees.permits ? store.permits : undefined;
  const sharedOps = store.guarantees.shared ? store.shared : undefined;
  if (store.guarantees.permits && permitOps === undefined) {
    throw configError(
      'the store claims permits but has no permits ops',
      'Give the store `permits` ops or set guarantees.permits to false.',
    );
  }
  if (store.guarantees.shared && sharedOps === undefined) {
    throw configError(
      'the store claims shared locks but has no shared ops',
      'Give the store `shared` ops or set guarantees.shared to false.',
    );
  }
  if (leased && permitOps !== undefined && permitOps.extend === undefined) {
    throw configError('a lease store needs permits.extend', "Add `extend` to the store's permits ops.");
  }
  if (leased && sharedOps !== undefined && sharedOps.extend === undefined) {
    throw configError('a lease store needs shared.extend', "Add `extend` to the store's shared ops.");
  }
  const nonce = Math.random().toString(36).slice(2);
  let tokenCounter = 0;
  const counts = { releaseErrors: 0, leadAcquired: 0, leadLost: 0 };

  const nextToken = (): string => `${nonce}-${(tokenCounter++).toString(36)}`;
  const keyField = (key: Key): string => (logKeys ? key.full : 'hidden');

  // One in-flight remote attempt per key per process.
  const gates = new Map<string, Promise<void>>();
  async function gated<T>(key: Key, fn: () => Promise<T>): Promise<T> {
    if (store.guarantees.scope === 'process') return fn();
    const previous = gates.get(key.full) ?? Promise.resolve();
    const result = previous.then(fn);
    const tail = result.then(noop, noop);
    gates.set(key.full, tail);
    void tail.then(() => {
      if (gates.get(key.full) === tail) gates.delete(key.full);
    });
    return result;
  }

  /** Give a grant back with its own token, through the protocol that issued it. Never throws. */
  async function giveBack(protocol: Protocol, grant: Grant, why: string): Promise<void> {
    try {
      await withStoreTimeout(protocol.release(grant), storeTimeoutMs, 'release', scheduler);
    } catch (error) {
      log.error(toError(error), { why, key: keyField(grant.key) });
    }
  }

  type Attempt = { readonly grant: Grant; readonly sentAt: number };

  /** One store attempt: fresh owner token, bounded, and a late grant is handed back. */
  async function attemptOnce(
    protocol: Protocol,
    key: Key,
    waitMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Attempt | undefined> {
    if (signal !== undefined) await raceSignal(Promise.resolve(), signal);
    const request: AcquireRequest = {
      token: nextToken(),
      ...(leased ? { ttlMs: leaseMs } : {}),
      ...(waitMs === undefined ? {} : { waitMs }),
      ...(signal === undefined ? {} : { signal }),
    };
    const sentAt = scheduler.now();
    const raw = (async () => protocol.acquire(key, request))();
    const bound = storeTimeoutMs + (store.guarantees.wait === 'native' && waitMs !== undefined ? waitMs : 0);
    let grant: Grant | undefined;
    if (store.guarantees.releasedBy === 'transaction') {
      // The store runs on the caller's own transaction. Giving up early would hand that
      // transaction back while the store still has a statement on it, so the caller's next
      // statement would land in the middle of the store's wait. Wait for the store instead.
      try {
        grant = await raw;
      } catch (error) {
        throw asStoreError(error, 'acquire');
      }
      if (signal?.aborted === true) {
        if (grant !== undefined) await giveBack(protocol, grant, 'aborted');
        await raceSignal(Promise.resolve(), signal);
      }
    } else {
      try {
        const timed = withStoreTimeout(raw, bound, 'acquire', scheduler);
        grant = await (signal === undefined ? timed : raceSignal(timed, signal));
      } catch (error) {
        // Attached only once we have given up, so it also catches a grant that
        // already landed in the same instant: nobody else will release it.
        void raw.then(late => {
          if (late !== undefined) void giveBack(protocol, late, 'late grant');
        }, noop);
        throw asStoreError(error, 'acquire');
      }
    }
    if (grant === undefined) return undefined;
    if (leased && scheduler.now() - sentAt >= leaseMs) {
      log.warn('grant for {key} arrived after its ttl; refused', { key: keyField(key) });
      await giveBack(protocol, grant, 'stale grant');
      return undefined;
    }
    return { grant, sentAt };
  }

  /** Sleep between attempts: a wake-up from the store, or full-jitter backoff. Wakes early on abort. */
  async function pause(
    key: Key,
    leftMs: number,
    attempt: number,
    signal: AbortSignal | undefined,
    session: Waiter | undefined,
  ): Promise<void> {
    const waitFor =
      session === undefined
        ? store.waitFor === undefined
          ? undefined
          : (s: AbortSignal): Promise<void> => store.waitFor?.(key, s) ?? Promise.resolve()
        : (s: AbortSignal): Promise<void> => session.waitFor(s);
    const ms = waitFor === undefined ? Math.min(backoffDelay(attempt), leftMs) : Math.min(leftMs, BACKOFF_MAX_MS);
    const wakeup = new AbortController();
    const onAbort = (): void => {
      wakeup.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer: SchedulerHandle | undefined;
    const elapsed = new Promise<void>(resolve => {
      timer = scheduler.setTimeout(resolve, ms, { ref: true });
    });
    const woken = new Promise<void>(resolve => {
      wakeup.signal.addEventListener('abort', () => {
        resolve();
      });
    });
    const racers = [elapsed, woken];
    try {
      if (waitFor !== undefined) {
        // A failing waitFor, sync or async, must not end the wait early or leak the timer: the timer still bounds it.
        const failed = (error: unknown): Promise<void> => {
          log.error(toError(error), { note: 'waitFor failed; falling back to backoff', key: keyField(key) });
          return neverSettlesVoid;
        };
        try {
          racers.push(waitFor(wakeup.signal).catch(failed));
        } catch (error) {
          void failed(error);
        }
      }
      await Promise.race(racers);
    } finally {
      if (timer !== undefined) scheduler.clearTimeout(timer);
      wakeup.abort();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // -------------------------------------------------------------------------
  // The guard: renewal loop, deadline, loss, release
  // -------------------------------------------------------------------------

  function makeHeld(protocol: Protocol, key: Key, first: Attempt, opts: CallOptions): Held {
    const { grant } = first;
    const controller = new AbortController();
    const holdMs = opts.holdAtLeast === undefined ? 0 : parseDuration(opts.holdAtLeast);
    const acquiredAt = scheduler.now();
    const extendFn =
      leased && protocol.extend !== undefined
        ? (g: Grant, ttlMs: number) => protocol.extend?.(g, ttlMs) ?? Promise.resolve(false)
        : undefined;
    let deadline = leased ? first.sentAt + leaseMs : Number.POSITIVE_INFINITY;
    const firstDeadline = deadline;
    let ended: 'released' | 'lost' | undefined;
    let lostError: LockError | undefined;
    let beatTimer: SchedulerHandle | undefined;
    let deadlineTimer: SchedulerHandle | undefined;
    let renewing: Promise<void> | undefined;
    let releasing: Promise<void> | undefined;
    // Removes the forwarder from the caller's signal. A long-lived signal (an app shutdown) must not collect one per hold.
    let detachCaller: (() => void) | undefined;

    const stopTimers = (): void => {
      detachCaller?.();
      detachCaller = undefined;
      if (beatTimer !== undefined) scheduler.clearTimeout(beatTimer);
      if (deadlineTimer !== undefined) scheduler.clearTimeout(deadlineTimer);
      beatTimer = undefined;
      deadlineTimer = undefined;
    };

    const lose = (detectedBy: 'renewal' | 'deadline' | 'connection', cause?: unknown): void => {
      if (ended !== undefined) return;
      ended = 'lost';
      stopTimers();
      lostError = new LockError({
        code: 'lost',
        message:
          detectedBy === 'renewal'
            ? 'the store no longer recognises this lock'
            : detectedBy === 'connection'
              ? 'the connection holding this lock ended'
              : 'the lease deadline passed without a confirmed renewal',
        remediation: 'Stop the work. The callback may have had side effects; nothing retries it.',
        detectedBy,
        ...(cause === undefined ? {} : { cause }),
      });
      log.error('lock {key} lost ({detectedBy})', { key: keyField(key), detectedBy });
      controller.abort(lostError);
    };

    const armDeadline = (): void => {
      if (deadlineTimer !== undefined) scheduler.clearTimeout(deadlineTimer);
      if (!Number.isFinite(deadline)) return;
      deadlineTimer = scheduler.setTimeout(
        () => {
          lose('deadline');
        },
        Math.max(0, deadline - scheduler.now()),
        { ref: false },
      );
    };

    const armBeat = (delayMs: number): void => {
      if (extendFn === undefined || ended !== undefined) return;
      // One chain only: an on-demand extend() replaces the pending beat.
      if (beatTimer !== undefined) scheduler.clearTimeout(beatTimer);
      beatTimer = scheduler.setTimeout(
        () => {
          beatTimer = undefined;
          if (ended !== undefined || renewing !== undefined) return;
          return renew();
        },
        delayMs,
        { ref: false },
      );
    };

    /** One renewal. Errors are logged and retried next beat until the deadline. */
    const renew = (): Promise<void> => {
      const run = (async (): Promise<void> => {
        if (extendFn === undefined) return;
        const sentAt = scheduler.now();
        let ok: boolean;
        try {
          ok = await withStoreTimeout(extendFn(grant, leaseMs), storeTimeoutMs, 'extend', scheduler);
        } catch (error) {
          log.error(toError(error), { note: 'renewal failed; retrying until the deadline', key: keyField(key) });
          armBeat(leaseMs / 3);
          return;
        }
        if (ended !== undefined) {
          // The lock was given up while the renewal was in flight: hand it back.
          if (ok) await giveBack(protocol, grant, 'late renewal');
          return;
        }
        if (!ok) {
          lose('renewal');
          return;
        }
        deadline = sentAt + leaseMs;
        armDeadline();
        armBeat(leaseMs / 3);
      })();
      renewing = run;
      return run.finally(() => {
        if (renewing === run) renewing = undefined;
      });
    };

    const doRelease = async (): Promise<void> => {
      const wait = Math.max(0, holdMs - (scheduler.now() - acquiredAt));
      if (wait > 0) {
        await new Promise<void>(resolve => {
          scheduler.setTimeout(resolve, wait, { ref: true });
        });
      }
      if (ended === 'lost') return;
      ended = 'released';
      stopTimers();
      let outcome;
      try {
        outcome = await withStoreTimeout(protocol.release(grant), storeTimeoutMs, 'release', scheduler);
      } catch (error) {
        throw asReleaseError(error);
      }
      if (outcome === 'unknown') {
        throw new LockError({
          code: 'release',
          message: 'the store could not confirm the release',
          remediation: 'The lock frees itself when its lease or connection ends. Check the store.',
          outcome: 'unknown',
          method: 'release',
        });
      }
      log.debug('released {key} ({outcome})', { key: keyField(key), outcome });
    };

    const release = (): Promise<void> => {
      releasing ??= doRelease();
      return releasing;
    };

    const callerSignal = opts.signal;
    if (callerSignal !== undefined) {
      const forward = (): void => {
        controller.abort(callerSignal.reason);
      };
      if (callerSignal.aborted) forward();
      else {
        callerSignal.addEventListener('abort', forward, { once: true });
        detachCaller = () => {
          callerSignal.removeEventListener('abort', forward);
        };
      }
    }

    const guard: GuardImpl = {
      key,
      signal: controller.signal,
      get held() {
        return ended === undefined && scheduler.now() < deadline;
      },
      fence: grant.fence,
      get expiresAt() {
        return grant.expiresAt === undefined ? undefined : grant.expiresAt + (deadline - firstDeadline);
      },
      ...(extendFn === undefined
        ? {}
        : {
            extend: async (): Promise<void> => {
              if (ended === 'lost' && lostError !== undefined) throw lostError;
              if (renewing === undefined) {
                await renew();
              } else {
                await renewing;
              }
              if (ended === 'lost' && lostError !== undefined) throw lostError;
            },
          }),
      release,
      [Symbol.asyncDispose]: release,
    };

    void grant.lost?.then(reason => {
      lose('connection', reason);
    });
    log.debug('acquired {key}', { key: keyField(key) });
    if (leased) {
      armDeadline();
      armBeat(leaseMs / 3);
    }
    const left = first.sentAt + leaseMs - scheduler.now();
    const renewNow = leased && left < leaseMs / 3 ? renew : undefined;
    return { guard, lostError: () => lostError, ...(renewNow === undefined ? {} : { renewNow }) };
  }

  // -------------------------------------------------------------------------
  // Verbs
  // -------------------------------------------------------------------------

  async function acquireHeld(
    protocol: Protocol,
    key: Key,
    opts: CallOptions,
    mode: 'try' | 'wait',
  ): Promise<Held | undefined> {
    const waitMs = mode === 'wait' && opts.wait !== undefined ? parseDuration(opts.wait) : undefined;
    if (mode === 'wait' && store.guarantees.scope !== 'process' && waitMs === undefined && opts.signal === undefined) {
      throw new LockError({
        code: 'config',
        message: 'a wait on a non-process store needs wait or signal',
        remediation: "Pass { wait: '5s' } or { signal }.",
      });
    }
    const limit = waitMs === undefined ? Number.POSITIVE_INFINITY : scheduler.now() + waitMs;
    // A mode-aware wait (writer preference) lives from the first refusal until this loop ends,
    // so a woken writer is still counted while its next attempt is in flight.
    let session: Waiter | undefined;
    try {
      for (let attempt = 0; ; attempt++) {
        const remaining = Math.max(0, limit - scheduler.now());
        const nativeWait =
          mode === 'wait' && store.guarantees.wait === 'native' && Number.isFinite(remaining) ? remaining : undefined;
        const got = await gated(key, () => attemptOnce(protocol, key, nativeWait, opts.signal));
        if (got !== undefined) {
          const held = makeHeld(protocol, key, got, opts);
          // A grant with less than ttl/3 left renews at once instead of waiting a beat.
          if (held.renewNow !== undefined) await held.renewNow();
          // Lost before the callback starts (refused, or past the deadline): never acquired.
          if (held.lostError() === undefined) return held;
        }
        if (mode === 'try') return undefined;
        const left = limit - scheduler.now();
        if (left <= 0) throw heldError();
        session ??= protocol.waiter?.(key);
        await pause(key, left, attempt, opts.signal, session);
      }
    } finally {
      session?.close();
    }
  }

  async function runHeld<T>(
    held: Held,
    fn: (ctx: ContextImpl) => T | Promise<T>,
    opts: CallOptions,
  ): Promise<Awaited<T>> {
    const { guard } = held;
    let settled: Settled<Awaited<T>>;
    try {
      settled = { ok: true, value: await fn({ signal: guard.signal, fence: guard.fence, key: guard.key }) };
    } catch (error) {
      settled = { ok: false, error };
    }
    let releaseError: LockError | undefined;
    try {
      await guard.release();
    } catch (error) {
      releaseError = asReleaseError(error);
    }
    const lost = held.lostError();
    if (!settled.ok) {
      addSuppressed(
        settled.error,
        [lost, releaseError].filter(e => e !== undefined),
      );
      throw settled.error;
    }
    if (lost !== undefined && (opts.onLost ?? 'abort') === 'abort') throw lost;
    if (releaseError !== undefined) {
      // Decision 4: the callback succeeded, so the value is returned. The failure is reported, not thrown.
      counts.releaseErrors += 1;
      log.error('release of {key} failed after a successful callback: {error}', {
        key: keyField(guard.key),
        error: releaseError,
      });
      try {
        onReleaseError?.(releaseError);
      } catch (error) {
        log.error(toError(error), { note: 'onReleaseError threw' });
      }
    }
    return settled.value;
  }

  /** The four verbs over one key. `protocolFor` runs per call, so a semaphore can check `weight` first. */
  function handleOver(key: Key, protocolFor: (opts: CallOptions) => Protocol): HandleImpl {
    return {
      async tryRun<T>(fn: (ctx: ContextImpl) => T | Promise<T>, opts: CallOptions = {}): Promise<LockRun<Awaited<T>>> {
        const held = await acquireHeld(protocolFor(opts), key, opts, 'try');
        if (held === undefined) return { ran: false };
        return { ran: true, value: await runHeld(held, fn, opts) };
      },
      async run<T>(fn: (ctx: ContextImpl) => T | Promise<T>, opts: CallOptions = {}): Promise<Awaited<T>> {
        const held = await acquireHeld(protocolFor(opts), key, opts, 'wait');
        if (held === undefined) throw heldError();
        return runHeld(held, fn, opts);
      },
      async acquire(opts = {}) {
        const held = await acquireHeld(protocolFor(opts), key, opts, 'wait');
        if (held === undefined) throw heldError();
        return held.guard;
      },
      async tryAcquire(opts = {}) {
        const held = await acquireHeld(protocolFor(opts), key, opts, 'try');
        return held?.guard;
      },
    };
  }

  const mutexProtocol: Protocol = {
    acquire: (key, req) => store.acquire(key, req),
    release: grant => store.release(grant),
    ...(store.extend === undefined
      ? {}
      : { extend: (grant, ttlMs) => store.extend?.(grant, ttlMs) ?? Promise.resolve(false) }),
  };

  function mutex(name: string): HandleImpl {
    const key = createKey(namespace, name);
    const handle = handleOver(key, () => mutexProtocol);
    if (!leased) return handle;
    return {
      ...handle,
      lead: (fn, opts) =>
        lead(
          {
            key,
            keyField: keyField(key),
            scheduler,
            beatMs: leaseMs / 3,
            counts,
            tryAcquire: callOpts => handle.tryAcquire(callOpts),
            ...(store.waitFor === undefined ? {} : { waitFor: (k, s) => store.waitFor?.(k, s) ?? Promise.resolve() }),
            onReleaseError: error => {
              const releaseError = asReleaseError(error);
              counts.releaseErrors += 1;
              log.error('release of {key} failed while leading: {error}', { key: keyField(key), error: releaseError });
              try {
                onReleaseError?.(releaseError);
              } catch (hookError) {
                log.error(toError(hookError), { note: 'onReleaseError threw' });
              }
            },
          },
          fn,
          opts,
        ),
    };
  }

  function semaphoreOver(ops: PermitOps): (name: string, config: SemaphoreConfig) => HandleImpl {
    return (name, config) => {
      const parsedConfig = semaphoreConfigSchema.safeParse(config);
      if (!parsedConfig.success) {
        throw configError(
          `semaphore limit ${parsedConfig.error.issues.map(issue => issue.message).join(', ')}`,
          'Pass { limit } as a positive integer.',
        );
      }
      const { limit } = parsedConfig.data;
      return handleOver(createKey(namespace, name, 'semaphore'), opts => {
        const parsedWeight = weightSchema.safeParse(opts.weight ?? 1);
        if (!parsedWeight.success || parsedWeight.data > limit) {
          throw configError(
            `weight must be a positive integer of at most the limit (${limit})`,
            'Pass a smaller weight, or declare a larger limit.',
          );
        }
        const weight = parsedWeight.data;
        return {
          acquire: (key, req) => ops.acquire(key, { ...req, limit, weight }),
          release: grant => ops.release(grant),
          waiter: k => ops.waiter?.(k, weight),
          ...(ops.extend === undefined
            ? {}
            : { extend: (grant, ttlMs) => ops.extend?.(grant, ttlMs) ?? Promise.resolve(false) }),
        };
      });
    };
  }

  function readWriteOver(ops: SharedOps): (name: string) => ReadWriteImpl {
    return name => {
      const key = createKey(namespace, name, 'readWrite');
      const side = (mode: 'read' | 'write'): HandleImpl => {
        const protocol: Protocol = {
          acquire: (k, req) => ops.acquire(k, { ...req, mode }),
          release: grant => ops.release(grant),
          waiter: k => ops.waiter?.(k, mode),
          ...(ops.extend === undefined
            ? {}
            : { extend: (grant, ttlMs) => ops.extend?.(grant, ttlMs) ?? Promise.resolve(false) }),
        };
        return handleOver(key, () => protocol);
      };
      return { read: side('read'), write: side('write') };
    };
  }

  return {
    store,
    counters: counts,
    mutex,
    ...(permitOps === undefined ? {} : { semaphore: semaphoreOver(permitOps) }),
    ...(sharedOps === undefined ? {} : { readWrite: readWriteOver(sharedOps) }),
  };
}
