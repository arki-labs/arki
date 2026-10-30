/**
 * A busy lock is an answer the caller branches on, so it is returned as the
 * {@link LockHeld} failure. Operational outcomes are canonical returned failures;
 * LockError remains the internal protocol and the thrown misuse/configuration error.
 */
import { z } from 'zod';

import { ID_GENERATION_FAILURES, RandomSourceUnavailable } from '@arki/contracts';

import type { FailureOf } from '@arki/failure';
import { defineFailure, UnexpectedDefect, UnexpectedFailure } from '@arki/failure';

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
  readonly outcome?: ReturnType<typeof LockStoreFailure>['data']['outcome'];
  /** On `lost`: the store refused a renewal, the local deadline passed, or the pinned connection closed. */
  readonly detectedBy?: ReturnType<typeof LockLost>['data']['detectedBy'];
  /** On `store` and `release`: which store call failed. */
  readonly method?: Exclude<ReturnType<typeof LockStoreFailure>['data']['method'], 'ddl' | 'dispose'>;
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

/** Cancellation ended acquisition before callback execution.
 * @fix Stop waiting; do not replay work with the same cancelled signal.
 * @verify bun run test -- src/outcomes.test.ts
 */
export const LockAborted = defineFailure('lock.aborted', {
  status: 499,
  message: 'Lock acquisition was cancelled before work started.',
  remediation: 'Stop waiting or start a new operation with a fresh signal.',
});

/** Ownership ended after work may have started. This never authorizes replay.
 * @fix Reconcile side effects and enforce fences before another attempt.
 * @verify bun run test -- src/locks.test.ts
 */
export const LockLost = defineFailure('lock.lost', {
  status: 409,
  data: z.object({ detectedBy: z.enum(['renewal', 'deadline', 'connection']) }),
  message: 'Lock ownership was lost; work may already have produced effects.',
  remediation: 'Reconcile work before replay and enforce the fence at the protected resource.',
});

/** A backend operation failed with explicit ownership uncertainty.
 * @fix Reconcile unknown ownership before assuming the key is free.
 * @verify bun run test -- src/outcomes.test.ts
 */
export const LockStoreFailure = defineFailure('lock.store', {
  status: 503,
  data: z.object({
    method: z.enum(['acquire', 'release', 'extend', 'waitFor', 'permits', 'shared', 'dispose', 'ddl']),
    outcome: z.enum(['not-acquired', 'unknown']),
    timeoutMs: z.number().optional(),
  }),
  message: 'The lock backend could not confirm the operation.',
  remediation: 'Check the backend and reconcile unknown ownership before proceeding.',
});

/** Release was not confirmed. Successful callback work must never be replayed on this evidence.
 * @fix Reconcile ownership or wait for the lease or connection to end.
 * @verify bun run test -- src/outcomes.test.ts
 */
export const LockReleaseFailed = defineFailure('lock.release', {
  status: 503,
  data: z.object({ outcome: z.literal('unknown') }),
  message: 'The lock release was not confirmed.',
  remediation: 'Reconcile ownership; callback effects may already be complete.',
});

/** Normalize an owned operation once; causes remain private failure metadata. */
export function lockFailure(error: unknown) {
  if (error instanceof UnexpectedFailure) error = error.failure;
  if (RandomSourceUnavailable.is(error)) return error;
  if (LockAborted.is(error) || LockLost.is(error) || LockStoreFailure.is(error) || UnexpectedDefect.is(error)) return error;
  if (error instanceof LockError) {
    if (error.code === 'config' || error.code === 'unsupported') throw error;
    if (error.code === 'aborted') return LockAborted({ cause: error });
    if (error.code === 'lost') return LockLost({ detectedBy: error.detectedBy ?? 'connection' }, { cause: error });
    if (LockStoreFailure.is(error.cause)) return error.cause;
    return LockStoreFailure({
      method: error.method ?? 'acquire',
      outcome: error.outcome ?? 'unknown',
      ...(error.timeoutMs === undefined ? {} : { timeoutMs: error.timeoutMs }),
    }, { cause: error });
  }
  return UnexpectedDefect({ cause: error });
}

/** A named store owns its provider rejection, including unknown remote effects. */
export function storeFailure(error: unknown, method: ReturnType<typeof LockStoreFailure>['data']['method']) {
  if (error instanceof UnexpectedFailure && UnexpectedDefect.is(error.failure)) return error.failure;
  if (error instanceof LockError && (error.code === 'config' || error.code === 'unsupported')) throw error;
  if (LockStoreFailure.is(error)) return error;
  return LockStoreFailure({
    method,
    outcome: error instanceof LockError ? (error.outcome ?? 'unknown') : 'unknown',
  }, { cause: error });
}

/** Every canonical operation outcome, with the original LockHeld definition retained. */
export const LOCK_RUN_FAILURES = [LockHeld, LockAborted, LockLost, LockStoreFailure, ...ID_GENERATION_FAILURES] as const;
export const LOCK_FAILURES = [...LOCK_RUN_FAILURES, LockReleaseFailed] as const;
export type LockOperationFailure = ReturnType<typeof lockFailure>;
export type StoreFailure = ReturnType<typeof storeFailure>;
export type ReleaseFailure = ReturnType<typeof releaseFailure>;

/** Manual release exposes uncertainty without converting completed work into a replay request. */
export function releaseFailure(error: unknown) {
  if (LockReleaseFailed.is(error)) return error;
  if (error instanceof LockError && LockReleaseFailed.is(error.cause)) return error.cause;
  return LockReleaseFailed({ outcome: 'unknown' }, { cause: error });
}

/** Exact run outcomes from their canonical definition source. */
export type LockRunFailure = FailureOf<(typeof LOCK_RUN_FAILURES)[number]>;
