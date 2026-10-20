import { getLogger } from '@arki/log';

/**
 * Debug logger for queue registration operations
 * Enable with: DEBUG=queue:register
 */
export const debugRegister = getLogger('queue:register');

/**
 * Debug logger for job execution operations
 * Enable with: DEBUG=queue:job
 */
export const debugJob = getLogger('queue:job');

/**
 * Debug logger for flow orchestration operations
 * Enable with: DEBUG=queue:flow
 */
export const debugFlow = getLogger('queue:flow');

/**
 * Debug logger for schedule operations
 * Enable with: DEBUG=queue:schedule
 */
export const debugSchedule = getLogger('queue:schedule');

/**
 * Debug logger for middleware operations
 * Enable with: DEBUG=queue:middleware
 */
export const debugMiddleware = getLogger('queue:middleware');

/**
 * Debug logger for worker lifecycle operations
 * Enable with: DEBUG=queue:worker
 */
export const debugWorker = getLogger('queue:worker');

/**
 * Debug logger for builder operations
 * Enable with: DEBUG=queue:builder
 */
export const debugBuilder = getLogger('queue:builder');

/**
 * Enable all queue debug logs
 * Enable with: DEBUG=queue:*
 */

/** Observer callbacks, including app-owned logging sinks and trace sources, never own queue outcomes. */
export function observeQueue(observe: () => void): void {
  try {
    observe();
  } catch {
    // Logging remains best effort; explicit job.log provider commands are supervised separately.
  }
}
