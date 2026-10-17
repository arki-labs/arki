export { LOCK_ERROR_CODES, LockError, LockHeld } from './errors.js';
export type { LockErrorCode, LockErrorInit, LockMethod } from './errors.js';
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
