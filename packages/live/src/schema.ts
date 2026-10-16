/**
 * @internal The runtime checks of the wire and meta shapes. Internal: the
 * public types are the plain ones in `types.ts`, and `schema.types.test.ts`
 * proves each schema here parses to exactly that type. Nothing public may
 * import this module's types (`library-check` TYPES_E001).
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

/** A scope dimension's name, e.g. `org`: it keys meta, `hello` and grants, so it stays a plain identifier. */
export const dimensionSchema = z.string().regex(/^[a-z_]\w{0,62}$/i);

/** A key fits one NOTIFY with room to spare: at most 512 bytes (longer ones make the trigger send an overflow). */
export const MAX_KEY_BYTES = 512;

/** One scope key as Postgres prints it (`::text`). */
export const scopeKeySchema = z.string().refine(key => new TextEncoder().encode(key).length <= MAX_KEY_BYTES, {
  message: `a scope key is at most ${MAX_KEY_BYTES} bytes`,
});

export const keyKindSchema = z.enum(['uuid', 'text', 'int']);

/** A path into a procedure's input: `[]` is the input itself. */
const inputPathSchema = z.array(z.string().min(1)).max(16);

const sessionSourceSchema = z.object({ from: z.literal('session') }).strict();

/** Contract meta of a live procedure: the tables it reads, and where each scope key comes from. Plain JSON, so `dot explain` shows it. */
export const liveMetaSchema = z.object({
  live: z
    .object({
      version: z.literal(1),
      reads: z.array(tableTagSchema).min(1).max(256),
      scope: z
        .record(
          dimensionSchema,
          z.discriminatedUnion('from', [
            z.object({ from: z.literal('input'), path: inputPathSchema }).strict(),
            sessionSourceSchema,
          ]),
        )
        .optional(),
    })
    .strict()
    .optional(),
});

/** Every live procedure of an app: its oRPC path, the tables it reads and its scope. Sent in `hello`. */
export const liveManifestSchema = z
  .array(
    z
      .object({
        path: z.array(z.string().min(1)).min(1).max(32),
        reads: z.array(tableTagSchema).min(1).max(256),
        scope: z
          .record(
            dimensionSchema,
            z.discriminatedUnion('from', [
              z.object({ from: z.literal('input'), path: inputPathSchema, kind: keyKindSchema }).strict(),
              sessionSourceSchema,
            ]),
          )
          .optional(),
      })
      .strict(),
  )
  .max(4096);

/** A grant holds at most this many keys per dimension. */
export const MAX_GRANT_KEYS = 4096;

/** A frame holds at most this many scope keys, over all its tags; a bigger window splits. */
export const MAX_KEYS_PER_FRAME = 1024;

/** A tag in a `change` frame: a scoped table's names its dimension and the keys this stream may see. */
const changeTagSchema = tableTagSchema
  .extend({
    scope: z
      .object({ name: dimensionSchema, keys: z.array(scopeKeySchema).min(1).max(MAX_KEYS_PER_FRAME) })
      .strict()
      .optional(),
  })
  .strict();

/** The scope declaration (`liveScopes`), as plain data. Server only. */
export const liveScopesSchema = z
  .object({
    dimensions: z.array(dimensionSchema).min(1).max(64),
    tables: z
      .array(
        z.object({ tag: tableTagSchema, dimension: dimensionSchema, column: identifier, kind: keyKindSchema }).strict(),
      )
      .min(1),
  })
  .strict();

/**
 * @internal A Postgres transaction id (`pg_current_xact_id()`, an `xid8`) in decimal. A string,
 * because an `xid8` can pass `Number.MAX_SAFE_INTEGER`.
 */
export const txIdSchema = z.string().regex(/^[1-9]\d{0,19}$/);

/** A receipt: 22 base64url characters, an HMAC of a transaction id (`receipts.ts`). */
export const liveReceiptSchema = z.string().regex(/^[\w-]{22}$/);

/** An opaque base64url token of 16 to 256 characters (the hub's are 75): a sealed stream position. Grants nothing. */
export const liveCursorSchema = z.string().regex(/^[\w-]{16,256}$/);

/** The frames of the SSE stream. */
export const liveEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('hello'),
      v: z.literal(1),
      mode: z.enum(['resume', 'reset']),
      cursor: liveCursorSchema,
      manifest: liveManifestSchema,
      scopes: z
        .record(dimensionSchema, z.union([z.literal('all'), z.array(scopeKeySchema).max(MAX_GRANT_KEYS)]))
        .optional(),
    })
    .strict(),
  /** Tables changed by commits, and the receipts of exactly the commits that wrote them. */
  z
    .object({
      kind: z.literal('change'),
      cursor: liveCursorSchema,
      tags: z.array(changeTagSchema).min(1).max(256),
      txids: z.array(liveReceiptSchema).max(256),
    })
    .strict(),
  /** The server lost its Postgres listener: reconnect (the next `hello` is a reset). */
  z.object({ kind: z.literal('gap') }).strict(),
  /** The server closes on purpose (max age, stop, slow client): reconnect with the cursor. */
  z.object({ kind: z.literal('bye') }).strict(),
]);
