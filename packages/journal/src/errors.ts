import { z } from 'zod';

import { TRANSACTION_FAILURES } from '@arki/db/contract';

import { defineFailure, SCHEMA_FAILURES } from '@arki/failure';

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
  | 'INVALID_ACCEPT'
  | 'BAD_DEFINITION'
  | 'JOB_NOT_DEAD'
  | 'JOB_NOT_PENDING'
  | 'JOB_RUNNING'
  | 'JOB_EXISTS'
  | 'JOB_MANAGED'
  | 'BAD_ARGUMENT'
  | 'LEASE_LOST'
  | 'STEP_TIMEOUT'
  | 'WORKFLOW_LIMIT'
  | 'WORKFLOW_UNKNOWN'
  | 'WORKFLOW_SHAPE_CHANGED'
  | 'WORKFLOW_VERSION_RETIRED'
  | 'WORKFLOW_NOT_FOUND'
  | 'WORKFLOW_FINISHED'
  | 'WORKFLOW_COMPENSATING'
  | 'STEP_NOT_DEAD'
  | 'STEP_NOT_RESOLVABLE'
  | 'WORKFLOW_READ_MISMATCH';

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
    next: "Replay and repair cannot rebuild this row. Check whether the row existed before the journal, or restore the missing events. An entity declared with events: 'transient' keeps none, and the history verbs never apply to it",
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
    next: 'Return that failure from the handler, or another one: `if (isFailure(result)) return result;`. A command that met a failure must end with one, so none of its writes commit. To handle the refusal on purpose and still succeed, check it and call `accept(result)` first',
  },
  INVALID_ACCEPT: {
    what: '`accept` cannot mark this value as a handled refusal',
    next: 'Call `accept(result)` with the very failure a `write` or `run` of this handler returned, once for each return, before the handler returns',
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
  JOB_MANAGED: {
    what: 'a workflow run owns this job',
    next: "A step or timer of a workflow run is moved by the workflow's own actions, not by the raw job verbs. Use the workflow's actions",
  },
  JOB_EXISTS: {
    what: 'an unfinished job already holds this dedupe key',
    next: 'Wait for that job to finish, or cancel it, then try again',
  },
  BAD_ARGUMENT: {
    what: 'an argument is out of range',
    next: 'Fix the argument named in the detail, then call again',
  },
  LEASE_LOST: {
    what: 'this worker no longer holds the job: its lease ran out and another worker took it, or the job was finished or removed',
    next: 'Nothing was written. Stop the handler. The new owner runs the job, so a side effect outside the database needs an idempotency key',
  },
  STEP_TIMEOUT: {
    what: 'a workflow step ran longer than its timeout',
    next: 'The step failed and follows its retry. Raise the step `timeout`, or make the body stop when `ctx.signal` aborts',
  },
  WORKFLOW_LIMIT: {
    what: 'a workflow value is larger than `limits.payload`',
    next: 'Keep the input or the step result small: store the data elsewhere and return a reference, or raise `limits.payload`',
  },
  WORKFLOW_UNKNOWN: {
    what: 'no registered workflow has this name and version',
    next: 'Pass the workflow to `compose({ workflows })` in every process that starts or runs it, and keep the old version registered until its runs finish',
  },
  WORKFLOW_SHAPE_CHANGED: {
    what: 'the registered workflow has other nodes than the run was started with',
    next: 'A run keeps the shape it started with. Bump the workflow `version` for a changed shape, and keep the old version registered until its runs finish',
  },
  WORKFLOW_VERSION_RETIRED: {
    what: 'a newer version of this workflow is registered, so this version no longer starts runs',
    next: 'Start the run with the newest version. The older version stays registered only to finish the runs it already has',
  },
  WORKFLOW_NOT_FOUND: {
    what: 'no workflow run has this id',
    next: 'Check the run id, and that the run was not pruned after it finished',
  },
  WORKFLOW_FINISHED: {
    what: 'the workflow run is finished, so nothing can move it',
    next: 'A completed, failed or cancelled run is history. Start a new run to do the work again',
  },
  WORKFLOW_COMPENSATING: {
    what: 'the workflow run is undoing its work, so this action does not apply',
    next: 'Wait for compensation to end, or fix the failed undo (`retryStep` or `skipUndo`)',
  },
  STEP_NOT_DEAD: {
    what: 'this step is not dead, so there is nothing to retry or skip',
    next: 'Only a failed step, or a step whose job died because the run is stranded, can be moved by an operator. Read the run to see the step status',
  },
  STEP_NOT_RESOLVABLE: {
    what: 'an operator cannot supply the result of this step',
    next: 'Only a failed `do` step of a running run that declares an `output` schema can be resolved. Use `retryStep` instead',
  },
  WORKFLOW_READ_MISMATCH: {
    what: 'a stored value of this workflow run does not fit its schema, so `def.read` cannot give it typed',
    next: 'Read the run untyped with `journal.workflows.run`. A run started on an older version, or an input schema that transforms its value, can store values the schema no longer takes',
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
 * - A misused `accept` (a value the handler never received, accepted twice, called late,
 *   or not a failure) is a `JournalError` with code `INVALID_ACCEPT`.
 * - Command input, event data or `meta` that fails its schema returns `InvalidInput`
 *   from `@arki/failure`, with `data.issues`. An async schema in a sync call returns
 *   `AsyncSchema`; a throwing validator returns `ValidatorDefect`.
 * - An error thrown by a command handler, an `events` function, a reducer or a
 *   projection is normalized by command transaction ownership to `TransactionDefect` with a private cause.
 *   Direct low-level operations keep their documented exception contract. A rejected business rule is not thrown:
 *   it is returned as a failure (`CommandNotFound` and the others below), and
 *   `journal.run` returns it.
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
 * @fix Check the resource identifier and use an existing resource visible to this command.
 * @verify bun run test -- src/returned-failure.test.ts
 */
export const CommandNotFound = defineFailure('journal.not_found', {
  status: 404,
  data: CommandRefusal,
  message: '{detail}',
  remediation: 'Check the resource identifier and use an existing resource visible to this command.',
});
/** A {@link CommandNotFound} failure value. */
export type CommandNotFound = ReturnType<typeof CommandNotFound>;

/** The request is wrong in a way the input schema cannot see. See {@link CommandNotFound}.
 * @fix Correct the domain request described by the client-facing detail before submitting again.
 * @verify bun run test -- src/returned-failure.test.ts
 */
export const CommandInvalid = defineFailure('journal.invalid', {
  status: 400,
  data: CommandRefusal,
  message: '{detail}',
  remediation: 'Correct the domain request described by the client-facing detail before submitting again.',
});
/** A {@link CommandInvalid} failure value. */
export type CommandInvalid = ReturnType<typeof CommandInvalid>;

/** The caller may not do this. See {@link CommandNotFound}.
 * @fix Use a caller authorized for this command; do not retry the same unauthorized request.
 * @verify bun run test -- src/returned-failure.test.ts
 */
export const CommandForbidden = defineFailure('journal.forbidden', {
  status: 403,
  data: CommandRefusal,
  message: '{detail}',
  remediation: 'Use a caller authorized for this command; do not retry the same unauthorized request.',
});
/** A {@link CommandForbidden} failure value. */
export type CommandForbidden = ReturnType<typeof CommandForbidden>;

/** The current state does not allow it, such as an order that is already paid. See {@link CommandNotFound}.
 * @fix Refresh the resource state and choose an operation permitted by its current state.
 * @verify bun run test -- src/returned-failure.test.ts
 */
export const CommandConflict = defineFailure('journal.conflict', {
  status: 409,
  data: CommandRefusal,
  message: '{detail}',
  remediation: 'Refresh the resource state and choose an operation permitted by its current state.',
});
/** A {@link CommandConflict} failure value. */
export type CommandConflict = ReturnType<typeof CommandConflict>;

/** The pinned workflow code is unavailable or incompatible; keep the run unchanged until an operator restores it.
 * @fix Restore the pinned workflow version and original node shape before resuming the run.
 * @verify bun run test -- src/returned-failure.test.ts
 */
export const WorkflowStranded = defineFailure('journal.workflow_stranded', {
  status: 409,
  data: z.object({
    runId: z.string(),
    name: z.string(),
    version: z.number().int(),
    reason: z.enum(['WORKFLOW_UNKNOWN', 'WORKFLOW_SHAPE_CHANGED']),
    detail: z.string(),
  }),
  message: '{detail}',
  remediation: 'Restore the pinned workflow version and original node shape before resuming the run.',
});
export type WorkflowStranded = ReturnType<typeof WorkflowStranded>;

/** What `def.read` returns when a stored value of the run does not fit its schema. `field` is `input`, `output` or
 * `results.<node>`; `detail` is the `WORKFLOW_READ_MISMATCH` message, and the cause is the schema's `InvalidInput`,
 * with its issues.
 * @fix Read the run untyped with journal.workflows.run, or let the schema take the values older runs stored.
 * @verify bun run test -- src/workflow/def-read.test.ts
 */
export const WorkflowReadMismatch = defineFailure('journal.workflow_read_mismatch', {
  status: 409,
  data: z.object({ runId: z.string(), field: z.string(), detail: z.string() }),
  message: '{detail}',
  remediation: 'Read the run untyped with journal.workflows.run, or let the schema take the values older runs stored.',
});
/** A {@link WorkflowReadMismatch} failure value. */
export type WorkflowReadMismatch = ReturnType<typeof WorkflowReadMismatch>;

/** Failures owned by command execution, in addition to the command definition's inferred refusals. */
export const COMMAND_FAILURES = [...SCHEMA_FAILURES, ...TRANSACTION_FAILURES, CommandConflict] as const;
export type CommandFailure = ReturnType<(typeof COMMAND_FAILURES)[number]>;
