/**
 * Everything an oRPC contract needs from the queue, browser-safe: the
 * failures a job trigger returns (for the contract's error map) and the
 * job-id definition (for its output schema). Importing it never loads
 * bullmq or the queue runtime.
 */
export { JOB_TRIGGER_FAILURES, QueueAcceptanceUnknown, QueueUnavailable } from './errors.ts';
export type { JobTriggerFailure } from './errors.ts';
export { queueJobId } from './job-id.ts';
export type { QueueJobId } from './job-id.ts';
export type { JobTriggerResult } from './trigger.ts';
