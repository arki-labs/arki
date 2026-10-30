/** `@arki/lock`: distributed locks and semaphores over any store; a busy lock is a returned failure. */
export { LOCK_ERROR_CODES, LOCK_FAILURES, LOCK_RUN_FAILURES, LockAborted, LockLost, LockStoreFailure, LockReleaseFailed, LockError, LockHeld } from './errors.js';
export type { LockErrorCode, LockErrorInit, LockMethod, LockOperationFailure, LockRunFailure, StoreFailure, ReleaseFailure } from './errors.js';
export type { Scheduler, SchedulerHandle } from './scheduler.js';
export { LOCK_COUNTER_NAMES } from './types.js';
export type {
  AcquireRequest,
  CreateLocksOptions,
  Duration,
  FenceOf,
  Grant,
  Guarantees,
  Guard,
  Key,
  LeaderOps,
  LeadOptions,
  LockContext,
  LockCounters,
  Locks,
  LocksFor,
  LockVerbs,
  MutexHandle,
  PermitOps,
  PermitRequest,
  ReadWriteHandle,
  ReleaseOutcome,
  RunArgs,
  RunOptions,
  SemaphoreConfig,
  SemaphoreHandle,
  SharedOps,
  SharedRequest,
  Waiter,
  Store,
  TryOptions,
  WeightOption,
} from './types.js';

export { createLocks } from './locks.js';

export type { LockKey, LockToken, LockFence } from './identities.js';
