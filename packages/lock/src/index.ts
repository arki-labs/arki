export { LOCK_ERROR_CODES, LockError } from './errors.js';
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
  LockRun,
  Locks,
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
  Store,
  TryOptions,
} from './types.js';

export { createLocks } from './locks.js';
