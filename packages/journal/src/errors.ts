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

const MESSAGES: Record<JournalErrorCode, string> = {
  CONFLICT: 'another writer appended to this entity first',
  NO_ROW: 'the entity has no row, so the first event must be a create event',
  ROW_EXISTS: 'the entity already has a row, so a create event is not allowed',
  UNKNOWN_EVENT: 'the entity does not declare this event',
  VERSION_MISMATCH: 'the row version changed between lock and save',
  NO_HISTORY: 'the history does not start at version 1: the row existed before the journal',
  REPLAY_FAILED: 'the stored events could not be replayed',
  UNSTABLE_SCHEMA: 'the schema must accept its own stored output unchanged, because replay parses stored data again',
  ID_MISMATCH: 'the id is not the exact key the database stores',
  VALUE_MISMATCH: 'the database stored a different value than the reducer produced',
};

/** Every error the journal raises on purpose. Match on `code`, never on the message. */
export class JournalError extends Error {
  readonly code: JournalErrorCode;
  readonly kind: string;
  readonly entityId: string;

  constructor(code: JournalErrorCode, kind: string, entityId: string, detail?: string, options?: ErrorOptions) {
    const base = `${code}: ${MESSAGES[code]} (${kind} ${entityId})`;
    super(detail === undefined ? base : `${base}: ${detail}`, options);
    this.name = 'JournalError';
    this.code = code;
    this.kind = kind;
    this.entityId = entityId;
  }
}

export function isJournalError(error: unknown, code?: JournalErrorCode): error is JournalError {
  return error instanceof JournalError && (code === undefined || error.code === code);
}
