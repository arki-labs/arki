/**
 * The public shapes of `@arki/live`: the wire, the meta and the manifest.
 * Plain TypeScript, so no consumer is tied to a validator. The Zod schemas
 * that check them at runtime are internal (`schema.ts`); a type test proves
 * each schema parses to exactly its type here, so the two cannot drift.
 */

/** One table, by schema and name: the unit every hint and every declaration is made of. Names are at most 63 bytes. */
export type TableTag = { schema: string; table: string };

/** Contract meta of a live procedure: the tables it reads (1 to 256). Plain JSON, so `dot explain` shows it. */
export type LiveMeta = { live?: { version: 1; reads: TableTag[] } | undefined };

/** Every live procedure of an app: its oRPC path and the tables it reads. Sent in `hello`. At most 4096 entries. */
export type LiveManifest = { path: string[]; reads: TableTag[] }[];

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
  | { kind: 'hello'; v: 1; mode: 'resume' | 'reset'; cursor: LiveCursor; manifest: LiveManifest }
  /**
   * Tables changed by commits. `txids` are the receipts of exactly the commits that wrote one of
   * this frame's `tags`: never the raw transaction ids.
   */
  | { kind: 'change'; cursor: LiveCursor; tags: TableTag[]; txids: LiveReceipt[] }
  /** The server lost its Postgres listener: reconnect (the next `hello` is a reset). */
  | { kind: 'gap' }
  /** The server closes on purpose (max age, stop, slow client): reconnect with the cursor. */
  | { kind: 'bye' };
