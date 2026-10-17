/**
 * A busy lock is an answer the caller branches on, so it is returned as the
 * {@link LockHeld} failure. Everything else `@arki/lock` raises on purpose is a
 * thrown {@link LockError} with a stable `code`. Match on `code` (or
 * `errorCode`), never on the message.
 */
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

/**
 * The lock was busy: the one attempt was refused, or the wait ended with the
 * lock still held. `key` is the full key, present only when the manager was
 * made with `logKeys: true` (raw keys stay out of logs by default).
 * `waitedMs` is 0 for `tryRun` and `tryAcquire`.
 *
 * @fix Skip the work, or retry later. Pass a longer `wait` to `run` or `acquire` when the holder is usually quick.
 * @verify bun run test -- src/locks.test.ts
 */
export const LockHeld = defineFailure('lock.held', {
  status: 409,
  data: z.object({ key: z.string().optional(), waitedMs: z.number() }),
  message: ({ key, waitedMs }) =>
    `${key === undefined ? 'the lock' : `lock ${key}`} is held${waitedMs > 0 ? ` after waiting ${waitedMs} ms` : ''}`,
  remediation: 'Treat the key as busy and try again later, or raise wait.',
});

/** A {@link LockHeld} failure value. */
export type LockHeld = ReturnType<typeof LockHeld>;

/** Stable ids, one per `LockError.code`. Never renumber. `ARKI_LOCK_E001` was `held`, now the {@link LockHeld} failure. */
export const LOCK_ERROR_CODES = {
  /**
   * The caller's signal aborted the wait; the callback never ran.
   *
   * @fix Stop. The caller asked to cancel, so do not retry with the same signal.
   * @verify bun run test -- src/wait.test.ts
   */
  aborted: 'ARKI_LOCK_E002',
  /**
   * Ownership was lost while the callback ran. The callback may have had side effects; nothing retries it.
   *
   * @fix Check what the callback finished before running it again. Pass the lock's `signal` to the work so it stops early, and use the fence for writes.
   * @verify bun run test -- src/locks.test.ts
   */
  lost: 'ARKI_LOCK_E003',
  /**
   * Backend failure. Never treated as free or held.
   *
   * @fix Check the store (database, Redis or file system). When `outcome` is `unknown`, ownership may exist remotely, so wait for the lease to expire before you assume the key is free.
   * @verify bun run test -- src/locks.test.ts
   */
  store: 'ARKI_LOCK_E004',
  /**
   * `guard.release()` failed or reported `unknown`. `run` and `tryRun` never throw this after a successful callback.
   *
   * @fix Check the store. On a lease store the key frees itself after `ttl`. Count these with `locks.counters.releaseErrors`.
   * @verify bun run test -- src/locks.test.ts
   */
  release: 'ARKI_LOCK_E005',
  /**
   * Bad input or setup: empty key, bad duration, conflicting semaphore limit, session store on a pooled shape.
   *
   * @fix Fix the call named in the message: pass a non-empty key, a valid duration, one limit per semaphore key, and a single connection to a session store.
   * @verify bun run test -- src/key.test.ts
   */
  config: 'ARKI_LOCK_E006',
  /**
   * A store lacks a capability the types could not see. Nothing throws this today.
   *
   * @fix Use a store that declares the capability in its `guarantees`.
   * @verify bun run test -- src/locks.test.ts
   */
  unsupported: 'ARKI_LOCK_E007',
} as const;

/** Which failure a {@link LockError} is. */
export type LockErrorCode = keyof typeof LOCK_ERROR_CODES;

/** What a {@link LockError} is built from. */
export type LockErrorInit = {
  readonly code: LockErrorCode;
  readonly message: string;
  /** What to do about it, in one sentence. */
  readonly remediation: string;
  readonly cause?: unknown;
  /** On `store`: whether ownership might exist remotely. */
  readonly outcome?: 'not-acquired' | 'unknown';
  /** On `lost`: the store refused a renewal, the local deadline passed, or the pinned connection closed. */
  readonly detectedBy?: 'renewal' | 'deadline' | 'connection';
  /** On `store` and `release`: which store call failed. */
  readonly method?: 'acquire' | 'release' | 'extend' | 'waitFor' | 'permits' | 'shared';
  /** On `store`: set when `storeTimeout` fired. */
  readonly timeoutMs?: number;
  /** Lock-side errors that rode along with a callback error (the `using` convention). */
  readonly suppressed?: readonly Error[];
};

/** Which store call a {@link LockError} blames. */
export type LockMethod = NonNullable<LockErrorInit['method']>;

/** A thrown, coded error of `@arki/lock`: a bug, misuse, or a store fault. */
export class LockError extends Error {
  readonly code: LockErrorCode;
  /** The stable id of `code`, e.g. `ARKI_LOCK_E004`. */
  readonly errorCode: (typeof LOCK_ERROR_CODES)[LockErrorCode];
  readonly remediation: string;
  readonly outcome?: LockErrorInit['outcome'];
  readonly detectedBy?: LockErrorInit['detectedBy'];
  readonly method?: LockErrorInit['method'];
  readonly timeoutMs?: number;
  readonly suppressed?: readonly Error[];

  constructor(init: LockErrorInit) {
    const errorCode = LOCK_ERROR_CODES[init.code];
    super(`${errorCode}: ${init.message}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'LockError';
    this.code = init.code;
    this.errorCode = errorCode;
    this.remediation = init.remediation;
    if (init.outcome !== undefined) this.outcome = init.outcome;
    if (init.detectedBy !== undefined) this.detectedBy = init.detectedBy;
    if (init.method !== undefined) this.method = init.method;
    if (init.timeoutMs !== undefined) this.timeoutMs = init.timeoutMs;
    if (init.suppressed !== undefined) this.suppressed = init.suppressed;
  }
}
