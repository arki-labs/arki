/**
 * Outbox errors: plain `Error`s with a stable `code` and a `remediation`. Every one is an
 * app bug (a wrong call, a bad stored row), so none is a typed client error.
 */

export const OUTBOX_ERROR_CODES = {
  notInTransaction: 'OUTBOX_E001',
  badArgs: 'OUTBOX_E002',
  notJson: 'OUTBOX_E003',
  badTiming: 'OUTBOX_E004',
  badStoredArgs: 'OUTBOX_E005',
  unknownJob: 'OUTBOX_E006',
  duplicateName: 'OUTBOX_E007',
} as const;

export type OutboxErrorCode = (typeof OUTBOX_ERROR_CODES)[keyof typeof OUTBOX_ERROR_CODES];

export type OutboxError = Error & { readonly code: OutboxErrorCode; readonly remediation: string };

const REMEDIATIONS: Readonly<Record<OutboxErrorCode, string>> = {
  OUTBOX_E001:
    'Call runAfter/runAt inside db.transaction(async tx => ...) and pass tx. A root database commits the row on its own, so it would not roll back with your write.',
  OUTBOX_E002: "Pass args that the job's .input(schema) accepts. The error's cause holds the schema issues.",
  OUTBOX_E003:
    'Job args are stored as plain JSON: use strings, finite numbers, booleans, null, arrays and plain objects; no undefined values, Date, Map, Set, bigint or class instances. Put large documents in storage and schedule their id, or raise maxArgsBytes.',
  OUTBOX_E004:
    'delayMs must be a non-negative safe integer, runAt needs a valid Date, and priority must be one of QUEUE_PRIORITIES.',
  OUTBOX_E005:
    "The stored args no longer pass the job's schema, so the job is dead without running. Fix the schema or the row, then journal.retry(db, id, { actor }); version job names when their input changes.",
  OUTBOX_E006: 'Register the job in the registry the outbox runner was built from.',
  OUTBOX_E007: 'Give every job in the registry its own name: the name is how a stored row finds its job.',
};

const CODES = new Set<string>(Object.values(OUTBOX_ERROR_CODES));

/** An outbox error with its code's remediation. `cause` keeps what went wrong underneath (e.g. the Zod error). */
export function outboxError(code: OutboxErrorCode, message: string, cause?: unknown): OutboxError {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  return Object.assign(error, { name: 'OutboxError', code, remediation: REMEDIATIONS[code] });
}

export function isOutboxError(error: unknown): error is OutboxError {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    CODES.has(error.code) &&
    'remediation' in error &&
    typeof error.remediation === 'string'
  );
}
