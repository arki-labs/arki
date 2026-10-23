/**
 * The event log seam: what the journal needs from wherever an entity's events live. The built-in
 * log (`journal_events`, in `store`) is one implementation. `seq` and `recordedAt` are assigned in
 * the app database before any append, so one event shape serves every log.
 * Imports only `pg` (types) and leaf files.
 */
import type { JournalTables } from './pg.js';
import type { DbHandle, EventStorage } from './types.js';

/** An event as a log stores and returns it: the `journal_events` row shape. */
export type StoredEvent = JournalTables['events']['$inferSelect'];
/** An event to append. `erasedAt` is the log's own, set by `erase`. */
export type EventToAppend = Omit<StoredEvent, 'erasedAt'>;

declare const eventLogPositionBrand: unique symbol;
/**
 * A log's own cursor into its global order: opaque, compared only by the log that made it.
 * The built-in log uses the event's `seq` as text. A store with another order (a commit
 * position, a resume token) uses its own form. `eventLogPositionSchema` in
 * `@arki/journal/zod` is the one way to make one.
 */
export type EventLogPosition = string & { readonly [eventLogPositionBrand]: true };

export type EventLogReads = {
  /** One entity's events, oldest first. */
  stream(
    kind: string,
    entityId: string,
    filter?: { readonly types?: readonly string[]; readonly afterVersion?: number; readonly limit?: number },
  ): Promise<readonly StoredEvent[]>;
  /** The entity's last version, 0 when it has no events. */
  highestVersion(kind: string, entityId: string): Promise<number>;
  /** Only when the log has a global order. Without it, async projections and `rerun` cannot run on it. */
  readonly all?: {
    /**
     * Events after `position` (`null`: from the start), in the log's order. `next` is where the
     * next call starts: past the last event returned, or past everything this call looked at
     * when fewer than `limit` matched. `null` only when the log is empty.
     */
    after(
      position: EventLogPosition | null,
      filter: { readonly kinds?: readonly string[]; readonly types?: readonly string[]; readonly limit: number },
    ): Promise<{
      readonly events: readonly (StoredEvent & { readonly position: EventLogPosition })[];
      readonly next: EventLogPosition | null;
    }>;
    /** The position of the newest event, `null` when the log is empty. */
    top(): Promise<EventLogPosition | null>;
    /** How many positions lie between two positions, when the log can tell. */
    distance?(from: EventLogPosition | null, to: EventLogPosition | null): number;
  };
};

export type EventLogWrites = {
  /**
   * Append one entity's events, all or nothing, at versions `expectedVersion + 1` onwards. The
   * same event ids again is a success that changes nothing. A version already taken by another
   * event is `JournalError('CONFLICT')`.
   */
  append(batch: {
    readonly kind: string;
    readonly entityId: string;
    readonly expectedVersion: number;
    readonly events: readonly EventToAppend[];
  }): Promise<void>;
  /**
   * Only when events can be rewritten in place: replace one event's data and stamp it erased.
   * Returns the stamp, which a second erase keeps. Without it, `forget` cannot run on the log.
   */
  erase?(
    at: Pick<StoredEvent, 'kind' | 'entityId' | 'version'>,
    patch: Pick<StoredEvent, 'data' | 'schemaVersion'>,
  ): Promise<{ readonly erasedAt: Date }>;
};

/**
 * A log that joins the row's transaction has no connection of its own: `bind(db)` gives it on the
 * app's handle, so the writer, `forget` and `repair` see their own uncommitted events. A log that
 * cannot join keeps its own connection and is used as it is.
 */
export type EventLog =
  | { readonly canJoinTransaction: true; bind(db: DbHandle): EventLogReads & EventLogWrites }
  | ({ readonly canJoinTransaction: false } & EventLogReads & EventLogWrites);

/** The log as seen on `db`: bound to it when the log joins transactions. */
export const logOn = (log: EventLog, db: DbHandle): EventLogReads & EventLogWrites =>
  log.canJoinTransaction ? log.bind(db) : log;

/**
 * Where one async projection is in the log. `behind`: the log holds events after `position`.
 * `distance`: how many positions it is behind, when the log can tell.
 */
export type ProjectionCursor = {
  readonly name: string;
  readonly position: EventLogPosition | null;
  readonly behind: boolean;
  readonly distance?: number;
};

/** `journal.forwardLag`: forward jobs not yet appended (`dead` of them stopped), and the oldest one's age. */
export type ForwardLag = {
  readonly pending: number;
  readonly dead: number;
  readonly oldestEnqueuedAt: Date | null;
};

/** The log's global order. Async projections and `rerun` walk it; a log without one cannot serve them. */
export function globalOrderOf(log: EventLogReads, what: string): NonNullable<EventLogReads['all']> {
  if (log.all === undefined) throw new Error(`journal: ${what} needs an event log with a global order`);
  return log.all;
}

/** A log that joins the row's transaction, and one that cannot. */
export type JoinedLog = Extract<EventLog, { readonly canJoinTransaction: true }>;
export type ForwardedLog = Extract<EventLog, { readonly canJoinTransaction: false }>;

/**
 * Where a write sends an entity's events: into a log inside the row's transaction (`'stored'` is
 * the built-in log), to a log that cannot join, through a `forward` job, or nowhere.
 */
export type EventRoute =
  | { readonly mode: 'joined'; readonly log: JoinedLog }
  | { readonly mode: 'forwarded'; readonly log: ForwardedLog }
  | { readonly mode: 'transient' };

export function routeOf(storage: EventStorage, builtIn: JoinedLog): EventRoute {
  if (storage === 'transient') return { mode: 'transient' };
  if (storage === 'stored') return { mode: 'joined', log: builtIn };
  return storage.canJoinTransaction ? { mode: 'joined', log: storage } : { mode: 'forwarded', log: storage };
}

/** A forwarded entity's job stream: its forward jobs run one after another, in version order. */
export const streamOf = (kind: string, entityId: string): string => `${kind}/${entityId}`;
