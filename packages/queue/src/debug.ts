import { debug } from '@arki/log/debug';

/**
 * Debug logger for queue registration operations
 * Enable with: DEBUG=queue:register
 */
export const debugRegister = debug('queue:register');

/**
 * Debug logger for job execution operations
 * Enable with: DEBUG=queue:job
 */
export const debugJob = debug('queue:job');

/**
 * Debug logger for flow orchestration operations
 * Enable with: DEBUG=queue:flow
 */
export const debugFlow = debug('queue:flow');

/**
 * Debug logger for schedule operations
 * Enable with: DEBUG=queue:schedule
 */
export const debugSchedule = debug('queue:schedule');

/**
 * Debug logger for middleware operations
 * Enable with: DEBUG=queue:middleware
 */
export const debugMiddleware = debug('queue:middleware');

/**
 * Debug logger for worker lifecycle operations
 * Enable with: DEBUG=queue:worker
 */
export const debugWorker = debug('queue:worker');

/**
 * Debug logger for builder operations
 * Enable with: DEBUG=queue:builder
 */
export const debugBuilder = debug('queue:builder');

/**
 * Enable all queue debug logs
 * Enable with: DEBUG=queue:*
 */
