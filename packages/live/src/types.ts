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

/** `${epoch}.${seq}`: the hub's random 12-character epoch and the frame number. Grants nothing. */
export type LiveCursor = string;

/** The frames of the SSE stream. */
export type LiveEvent =
  | { kind: 'hello'; v: 1; mode: 'resume' | 'reset'; cursor: LiveCursor; manifest: LiveManifest }
  /**
   * Tables changed by commits. `txids` are the transaction ids (`pg_current_xact_id()`, decimal
   * strings) of exactly the commits that wrote one of this frame's `tags`.
   */
  | { kind: 'change'; cursor: LiveCursor; tags: TableTag[]; txids: string[] }
  /** The server lost its Postgres listener: reconnect (the next `hello` is a reset). */
  | { kind: 'gap' }
  /** The server closes on purpose (max age, stop, slow client): reconnect with the cursor. */
  | { kind: 'bye' };
