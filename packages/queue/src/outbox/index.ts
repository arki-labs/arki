/**
 * `@arki/queue/outbox`: transactional scheduling. `outbox({ tables }).runAfter(tx, job, args)`
 * writes a job row in the caller's transaction; the journal worker runs it with `outboxRunner`.
 * Exactly-once enqueue, at-least-once execution. Portable: no BullMQ, Redis or pg-boss at runtime.
 */
export { outbox } from './outbox.ts';
export type { Outbox, OutboxOptions, OutboxTx, Scheduled, ScheduleOptions } from './outbox.ts';
export { outboxRunner } from './runner.ts';
export type { OutboxRunnerOptions } from './runner.ts';
export { isOutboxError, OUTBOX_ERROR_CODES } from './errors.ts';
export type { OutboxError, OutboxErrorCode } from './errors.ts';
export type { QueueRegistry } from './registry.ts';
