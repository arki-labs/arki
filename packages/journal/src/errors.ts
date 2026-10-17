import { z } from 'zod';

import { defineFailure } from '@arki/failure';

export type JournalErrorCode =
  | 'CONFLICT'
  | 'NO_ROW'
  | 'ROW_EXISTS'
  | 'UNKNOWN_EVENT'
  | 'VERSION_MISMATCH'
  | 'NO_HISTORY'
  | 'HISTORY_GAP'
  | 'REPLAY_FAILED'
  | 'UNSTABLE_SCHEMA'
  | 'ID_MISMATCH'
  | 'VALUE_MISMATCH'
  | 'IGNORED_FAILURE'
  | 'BAD_DEFINITION'
  | 'JOB_NOT_DEAD'
  | 'JOB_NOT_PENDING'
  | 'JOB_RUNNING'
  | 'JOB_EXISTS'
  | 'BAD_ARGUMENT';

/** Per code: what happened, and what to do next. The throw site adds the detail (event type, version, column). */
const MESSAGES: Record<JournalErrorCode, { readonly what: string; readonly next: string }> = {
  CONFLICT: {
    what: 'the row and its event history cannot accept this write',
    next: 'If another writer appended first, run the command again on the current state. If the row and the history disagree, check with `verify`, and use `repair` only when the history is complete',
  },
  NO_ROW: {
    what: 'no row exists, and this event has no `.create` reducer',
    next: 'Create the entity first, or declare `.create` for this event on the entity',
  },
  ROW_EXISTS: {
    what: 'a row exists, and this event has no `.on` reducer',
    next: 'Write an update event instead, or declare `.on` for this event on the entity',
  },
  UNKNOWN_EVENT: {
    what: 'the entity does not declare this event',
    next: 'Add `.create(Event, ...)` or `.on(Event, ...)` for it on this entity, or write it to the entity that declares it',
  },
  VERSION_MISMATCH: {
    what: 'no row matched the expected version when saving',
    next: 'The row version changed, or the row was removed, after this write locked it. Look for a statement that does this outside the journal (for example a direct update or delete inside `events`), then run the command again',
  },
  NO_HISTORY: {
    what: 'a complete history that starts at version 1 is not available',
    next: 'Replay and repair cannot rebuild this row. Check whether the row existed before the journal, or restore the missing events',
  },
  HISTORY_GAP: {
    what: 'the log has a hole, or the row is newer than a log that says it is alive',
    next: 'An event was lost after it was written. Replay and repair refuse to build a row the real history never produced. Restore the missing event from a backup, or accept the row as it is',
  },
  REPLAY_FAILED: {
    what: 'a stored event cannot be decoded or applied',
    next: 'Check the event schema and the reducers against the stored history',
  },
  UNSTABLE_SCHEMA: {
    what: 'the value changes or fails across JSON storage and a second parse',
    next: 'Return JSON-compatible data that the schema accepts unchanged, because replay parses stored data again',
  },
  ID_MISMATCH: {
    what: 'the entity id is not valid, or differs from its stored spelling',
    next: 'Use a non-empty, well-formed id within the limit, spelled exactly as stored. A uuid must be lower-case and hyphenated',
  },
  VALUE_MISMATCH: {
    what: 'the database stored a different value than the reducer produced',
    next: 'The write was rolled back. Make the reducer produce the value in the form the column stores',
  },
  IGNORED_FAILURE: {
    what: 'a write or a child command returned a failure, and the command still returned a success',
    next: 'Return that failure from the handler, or another one: `if (isFailure(result)) return result;`. A command that met a failure must end with one, so none of its writes commit',
  },
  BAD_DEFINITION: {
    what: 'a declaration is wrong',
    next: 'Fix the declaration named in the detail. It is thrown when the module that declares it loads, so no data was touched',
  },
  JOB_NOT_DEAD: {
    what: 'the job is not dead',
    next: 'Only a job that ran out of attempts can be retried or discarded. Look the job up first',
  },
  JOB_NOT_PENDING: {
    what: 'the job is not waiting to run',
    next: 'Only a job that has not run out of attempts can be cancelled. Look the job up first',
  },
  JOB_RUNNING: {
    what: 'a worker holds the job right now',
    next: 'Wait for it to finish, or for its lease to expire, then try again',
  },
  JOB_EXISTS: {
    what: 'an unfinished job already holds this dedupe key',
    next: 'Wait for that job to finish, or cancel it, then try again',
  },
  BAD_ARGUMENT: {
    what: 'an argument is out of range',
    next: 'Fix the argument named in the detail, then call again',
  },
};

/**
 * An error about one entity's row or history: a write, replay, verify or repair
 * that the journal refuses. Match on `code`, never on the message.
 *
 * Not every error the journal lets out is a `JournalError`:
 * - A wrong definition is a `JournalError` with code `BAD_DEFINITION`, thrown when the
 *   declaration runs (a bad name, a bad key column, a duplicate reducer or handler name).
 * - A misuse at run time is a plain `Error` whose message starts with `journal:` (two
 *   operations at once on one transaction, `drain` inside a transaction).
 * - Command input, event data or `meta` that fails its schema is a `SchemaError` from
 *   `@arki/schema`, with the schema's `issues`. A schema that cannot run (async where
 *   the journal parses sync, or a `validate` that throws) is a `SchemaRunError`.
 * - An error thrown by a command handler, an `events` function, a reducer or a
 *   projection passes through unchanged. A rejected business rule is one of
 *   these: a `CommandError`, below. It is better returned as a failure
 *   (`CommandNotFound` and the others below): `journal.run` returns it.
 * An error thrown by an effect is caught by `drain` and stored on the job.
 */
export class JournalError extends Error {
  readonly code: JournalErrorCode;
  readonly kind: string;
  readonly entityId: string;

  /** The message reads: `CODE: what happened (kind id): detail. What to do next.` */
  constructor(code: JournalErrorCode, kind: string, entityId: string, detail?: string, options?: ErrorOptions) {
    const { what, next } = MESSAGES[code];
    const where = `${code}: ${what} (${kind} ${entityId})`;
    const happened = detail === undefined ? where : `${where}: ${detail}`;
    super(`${happened}. ${next}.`, options);
    this.name = 'JournalError';
    this.code = code;
    this.kind = kind;
    this.entityId = entityId;
  }
}

export function isJournalError(error: unknown, code?: JournalErrorCode): error is JournalError {
  return error instanceof JournalError && (code === undefined || error.code === code);
}

/** What every command failure carries: the message, written for the client. */
const CommandRefusal = z.object({ detail: z.string() });

/**
 * The four failures a command returns when a rule of the app says no. Return one from a
 * command handler, its `authorize`, or the `events` function of a `write`: the command's
 * transaction rolls back, exactly as for a throw, and `journal.run` returns the same
 * failure to the caller. `detail` is the message, written for the client. An app may
 * return its own `defineFailure` values too; any failure rolls the command back.
 */
export const CommandNotFound = defineFailure('journal.not_found', {
  status: 404,
  data: CommandRefusal,
  message: '{detail}',
});
/** A {@link CommandNotFound} failure value. */
export type CommandNotFound = ReturnType<typeof CommandNotFound>;

/** The request is wrong in a way the input schema cannot see. See {@link CommandNotFound}. */
export const CommandInvalid = defineFailure('journal.invalid', {
  status: 400,
  data: CommandRefusal,
  message: '{detail}',
});
/** A {@link CommandInvalid} failure value. */
export type CommandInvalid = ReturnType<typeof CommandInvalid>;

/** The caller may not do this. See {@link CommandNotFound}. */
export const CommandForbidden = defineFailure('journal.forbidden', {
  status: 403,
  data: CommandRefusal,
  message: '{detail}',
});
/** A {@link CommandForbidden} failure value. */
export type CommandForbidden = ReturnType<typeof CommandForbidden>;

/** The current state does not allow it, such as an order that is already paid. See {@link CommandNotFound}. */
export const CommandConflict = defineFailure('journal.conflict', {
  status: 409,
  data: CommandRefusal,
  message: '{detail}',
});
/** A {@link CommandConflict} failure value. */
export type CommandConflict = ReturnType<typeof CommandConflict>;

/** The kind of answer a rejected request gets. The names are the usual HTTP ones: 404, 400, 403, 409. */
export type CommandErrorCode = 'NOT_FOUND' | 'BAD_REQUEST' | 'FORBIDDEN' | 'CONFLICT';

/**
 * A business rule rejected the request. App code throws it: a command handler,
 * or the `events` function of a `write`. The code names the kind of answer and
 * the message is written for the client.
 *
 * Prefer returning a failure: {@link CommandNotFound}, {@link CommandInvalid},
 * {@link CommandForbidden}, {@link CommandConflict}, or the app's own. It rolls
 * back the same way, and the caller's type shows it. `CommandError` still works.
 *
 * It is NOT a `JournalError`. A `JournalError` is the library's own failure: a
 * row or a history it refuses. A `CommandError` is the app's rule saying no.
 * The library never throws one and never changes one: like every error thrown
 * by app code, it leaves `journal.run` as the same instance, after the
 * command's transaction rolled back.
 *
 * Nothing here knows HTTP. The host maps the code to its own transport:
 * `@arki/journal/orpc` does it for oRPC, and any other host matches on the
 * code with `isCommandError`.
 */
export class CommandError extends Error {
  readonly code: CommandErrorCode;

  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

export function isCommandError(error: unknown, code?: CommandErrorCode): error is CommandError {
  return error instanceof CommandError && (code === undefined || error.code === code);
}
