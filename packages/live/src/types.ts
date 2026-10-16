/**
 * The public shapes of `@arki/live`: the wire, the meta and the manifest.
 * Plain TypeScript, so no consumer is tied to a validator. The Zod schemas
 * that check them at runtime are internal (`schema.ts`); a type test proves
 * each schema parses to exactly its type here, so the two cannot drift.
 */

/** One table, by schema and name: the unit every hint and every declaration is made of. Names are at most 63 bytes. */
export type TableTag = { schema: string; table: string };

/** How a scope key compares: a UUID in lower case, an integer in plain decimal, text exactly. Read from the Drizzle column. */
export type LiveKeyKind = 'uuid' | 'text' | 'int';

/**
 * Contract meta of a live procedure: the tables it reads (1 to 256), and per scope dimension
 * where its key comes from: a path into the input (`input.orgId` is `['orgId']`), or the session
 * (every key the stream is granted). Plain JSON, so `dot explain` shows it.
 */
export type LiveMeta = {
  live?:
    | {
        version: 1;
        reads: TableTag[];
        scope?: Record<string, { from: 'input'; path: string[] } | { from: 'session' }> | undefined;
      }
    | undefined;
};

/**
 * Every live procedure of an app: its oRPC path, the tables it reads, and its scope (an input
 * path also names the dimension's key kind, so a client compares keys the way Postgres prints
 * them). Sent in `hello`. At most 4096 entries.
 */
export type LiveManifest = {
  path: string[];
  reads: TableTag[];
  /** By dimension name. */
  scope?: Record<string, { from: 'input'; path: string[]; kind: LiveKeyKind } | { from: 'session' }> | undefined;
}[];

/**
 * One scoped table: its dimension, the NOT NULL column that holds its key, and that column's key
 * kind. Server only: the column name never reaches a client.
 */
export type LiveScopedTable<Dimension extends string = string> = {
  readonly tag: TableTag;
  readonly dimension: Dimension;
  readonly column: string;
  readonly kind: LiveKeyKind;
};

/**
 * The scope declaration `liveScopes` returns: the dimension names, and every scoped table (each
 * in one dimension). Plain data, read by `liveMigration`, `verifyLiveTriggers`, `touch`,
 * `liveManifest` and the endpoint.
 */
export type LiveScopes<Dimension extends string = string> = {
  readonly dimensions: readonly Dimension[];
  readonly tables: readonly LiveScopedTable<Dimension>[];
};

/**
 * A stream position, opaque: a base64url token (16 to 256 characters) that only the hub that made
 * it can open. Two cursors for one position differ, and none reveals a frame number, so a client
 * cannot count the frames its grant hides. Keep it as a string; it grants nothing.
 */
export type LiveCursor = string;

/**
 * A transaction as a client sees it: 22 base64url characters, an HMAC of the Postgres
 * transaction id under the app's secret (`liveReceipts`). One transaction has one receipt on every
 * stream and every hub that shares the secret. It shows no order and no count: compare it, nothing else.
 */
export type LiveReceipt = string;

/** The frames of the SSE stream. */
export type LiveEvent =
  /** `scopes`: the stream's own granted keys per dimension (`'all'`: every key). Never another client's. */
  | {
      kind: 'hello';
      v: 1;
      mode: 'resume' | 'reset';
      cursor: LiveCursor;
      manifest: LiveManifest;
      scopes?: Record<string, string[] | 'all'> | undefined;
    }
  /**
   * Tables changed by commits. A tag of a scoped table names its dimension and the changed keys
   * this stream may see (never another one). `txids` are the receipts of exactly the commits that
   * wrote one of this frame's tags (or keys): never the raw transaction ids.
   */
  | {
      kind: 'change';
      cursor: LiveCursor;
      tags: { schema: string; table: string; scope?: { name: string; keys: string[] } | undefined }[];
      txids: LiveReceipt[];
    }
  /** The server lost its Postgres listener: reconnect (the next `hello` is a reset). */
  | { kind: 'gap' }
  /** The server closes on purpose (max age, stop, slow client): reconnect with the cursor. */
  | { kind: 'bye' };
