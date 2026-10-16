/**
 * The wire and meta shapes of `@arki/live`. Every type is `z.infer` of one
 * schema here; nothing is restated elsewhere.
 */
import { z } from 'zod';

/** Postgres keeps identifiers to NAMEDATALEN - 1 = 63 bytes; a longer name would be cut and match another table. */
const MAX_IDENTIFIER_BYTES = 63;

const identifier = z
  .string()
  .min(1)
  .refine(name => new TextEncoder().encode(name).length <= MAX_IDENTIFIER_BYTES, {
    message: `a Postgres identifier is at most ${MAX_IDENTIFIER_BYTES} bytes`,
  });

/** One table, by schema and name. The unit every hint and every declaration is made of. */
export const tableTagSchema = z.object({ schema: identifier, table: identifier }).strict();

/** Contract meta of a live procedure: the tables it reads. Plain JSON, so `dot explain` shows it. */
export const liveMetaSchema = z.object({
  live: z
    .object({ version: z.literal(1), reads: z.array(tableTagSchema).min(1).max(256) })
    .strict()
    .optional(),
});

/** Every live procedure of an app: its oRPC path and the tables it reads. Sent in `hello`. */
export const liveManifestSchema = z
  .array(
    z
      .object({
        path: z.array(z.string().min(1)).min(1).max(32),
        reads: z.array(tableTagSchema).min(1).max(256),
      })
      .strict(),
  )
  .max(4096);

/**
 * @internal A Postgres transaction id (`pg_current_xact_id()`, an `xid8`) in decimal. A string,
 * because an `xid8` can pass `Number.MAX_SAFE_INTEGER`.
 */
export const txIdSchema = z.string().regex(/^[1-9]\d{0,19}$/);

/** `${epoch}.${seq}`: the hub's random 12-character epoch and the frame number. Grants nothing. */
export const liveCursorSchema = z.string().regex(/^[a-z0-9]{12}\.\d{1,15}$/);

/** The frames of the SSE stream. */
export const liveEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('hello'),
      v: z.literal(1),
      mode: z.enum(['resume', 'reset']),
      cursor: liveCursorSchema,
      manifest: liveManifestSchema,
    })
    .strict(),
  /**
   * Tables changed by commits. `txids` are those commits' transaction ids (decimal strings), on
   * the last frame of a batch: once it is handled, every query those commits touched is invalidated.
   */
  z
    .object({
      kind: z.literal('change'),
      cursor: liveCursorSchema,
      tags: z.array(tableTagSchema).min(1).max(256),
      txids: z.array(txIdSchema).max(256),
    })
    .strict(),
  /** The server lost its Postgres listener: reconnect (the next `hello` is a reset). */
  z.object({ kind: z.literal('gap') }).strict(),
  /** The server closes on purpose (max age, stop, slow client): reconnect with the cursor. */
  z.object({ kind: z.literal('bye') }).strict(),
]);

export type TableTag = z.infer<typeof tableTagSchema>;
export type LiveMeta = z.infer<typeof liveMetaSchema>;
export type LiveManifest = z.infer<typeof liveManifestSchema>;
export type LiveCursor = z.infer<typeof liveCursorSchema>;
export type LiveEvent = z.infer<typeof liveEventSchema>;
