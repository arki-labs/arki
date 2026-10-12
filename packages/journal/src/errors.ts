export type JournalErrorCode =
  | 'CONFLICT'
  | 'NO_ROW'
  | 'ROW_EXISTS'
  | 'UNKNOWN_EVENT'
  | 'VERSION_MISMATCH'
  | 'NO_HISTORY'
  | 'REPLAY_FAILED'
  | 'UNSTABLE_SCHEMA'
  | 'ID_MISMATCH'
  | 'VALUE_MISMATCH';

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
};

/**
 * An error about one entity's row or history: a write, replay, verify or repair
 * that the journal refuses. Match on `code`, never on the message.
 *
 * Not every error the journal lets out is a `JournalError`:
 * - A wrong definition or a misuse is a plain `Error` or `TypeError` whose message
 *   starts with `journal:` (a bad key column, a duplicate handler name, two
 *   operations at once on one transaction, `drain` inside a transaction).
 * - Command input, event data or `meta` that fails its schema is a `ZodError`.
 * - An error thrown by a command handler, an `events` function, a reducer or a
 *   projection passes through unchanged.
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
