/**
 * Outbox errors: plain `Error`s with a stable `code` and a `remediation`. Every one is an
 * app bug (a wrong call, a bad stored row), so none is a typed client error.
 */

import { z } from 'zod';

import { is } from '@arki/schema';

export const OUTBOX_ERROR_CODES = {
  /**
   * An outbox write was attempted outside the business transaction.
   * @fix Call runAfter or runAt inside db.transaction and pass the business transaction handle.
   * @verify bun run test -- src/outbox/outbox.spec.ts
   */
  notInTransaction: 'OUTBOX_E001',
  /**
   * The outbox arguments do not satisfy the job input schema.
   * @fix Pass args accepted by the job input schema; inspect the private schema issues.
   * @verify bun run test -- src/outbox/outbox.spec.ts
   */
  badArgs: 'OUTBOX_E002',
  /**
   * The outbox delay, scheduled time or priority is invalid.
   * @fix Use a non-negative safe-integer delay, a valid runAt Date and a supported QUEUE_PRIORITIES value.
   * @verify bun run test -- src/outbox/outbox.spec.ts
   */
  badTiming: 'OUTBOX_E004',
  /**
   * Stored outbox arguments do not satisfy the registered job input schema.
   * @fix Repair the stored args or restore the matching job schema before retrying the dead row; version job names when inputs change.
   * @verify bun run test -- src/outbox/outbox.spec.ts
   */
  badStoredArgs: 'OUTBOX_E005',
  /**
   * An outbox row names a job absent from the runner registry.
   * @fix Register the job in the registry used to construct the outbox runner.
   * @verify bun run test -- src/outbox/outbox.spec.ts
   */
  unknownJob: 'OUTBOX_E006',
  /**
   * Two jobs in the outbox registry use the same name.
   * @fix Give each job in the outbox registry a unique name.
   * @verify bun run test -- src/outbox/outbox.spec.ts
   */
  duplicateName: 'OUTBOX_E007',
} as const;

export type OutboxErrorCode = (typeof OUTBOX_ERROR_CODES)[keyof typeof OUTBOX_ERROR_CODES];

export type OutboxError = Error & { readonly code: OutboxErrorCode; readonly remediation: string };

const REMEDIATIONS: Readonly<Record<OutboxErrorCode, string>> = {
  OUTBOX_E001:
    'Call runAfter/runAt inside db.transaction(async tx => ...) and pass tx. A root database commits the row on its own, so it would not roll back with your write.',
  OUTBOX_E002: "Pass args that the job's .input(schema) accepts. The error's cause holds the schema issues.",
  OUTBOX_E004:
    'delayMs must be a non-negative safe integer, runAt needs a valid Date, and priority must be one of QUEUE_PRIORITIES.',
  OUTBOX_E005:
    "The stored args no longer pass the job's schema, so the job is dead without running. Fix the schema or the row, then journal.retry(db, id, { actor }); version job names when their input changes.",
  OUTBOX_E006: 'Register the job in the registry the outbox runner was built from.',
  OUTBOX_E007: 'Give every job in the registry its own name: the name is how a stored row finds its job.',
};

/** What makes an `Error` an {@link OutboxError}: one of the codes above and a remediation text. */
const outboxErrorShapeSchema = z.object({ code: z.enum(OUTBOX_ERROR_CODES), remediation: z.string() });

/** An outbox error with its code's remediation. `cause` keeps what went wrong underneath (e.g. the Zod error). */
export function outboxError(code: OutboxErrorCode, message: string, cause?: unknown): OutboxError {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  return Object.assign(error, { name: 'OutboxError', code, remediation: REMEDIATIONS[code] });
}

export function isOutboxError(error: unknown): error is OutboxError {
  return error instanceof Error && is(error, outboxErrorShapeSchema);
}
