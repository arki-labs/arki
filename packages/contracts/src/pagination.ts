import { z } from 'zod/v4';

/**
 * Keyset ("cursor") pagination, the browser-safe half: the order a list is
 * sorted by, the opaque cursor that marks where the next page starts, and
 * the page schemas a contract uses. `@arki/db/pagination` turns the same
 * declaration into `ORDER BY` and `WHERE` on the server.
 *
 * Why keyset and not offset: with `OFFSET`, a row inserted while someone is
 * reading shifts every later page by one, so a row repeats or vanishes. A
 * keyset cursor says "after this row", which stays true while rows come and go.
 *
 * Why the order must end on a unique key: rows with the same `createdAt`
 * (a bulk import writes thousands) have no order of their own, and Postgres
 * may return them differently on every query. `id` breaks the tie.
 */

/** Sort direction of one key. */
export type SortDirection = 'asc' | 'desc';

/** The sort order: row field → direction, most significant first. `{ createdAt: 'desc', id: 'desc' }`. */
export type KeysetOrder = Readonly<Record<string, SortDirection>>;

/** What a cursor can hold for one key: the value of a NOT NULL column. */
export type CursorValue = string | number | boolean | Date;

/** The decoded cursor: one value per key of the order. */
export type CursorValues<O extends KeysetOrder> = { readonly [K in keyof O]: CursorValue };

/** A keyset declaration — see {@link keyset}. */
export type Keyset<O extends KeysetOrder> = {
  /** The order, as declared. */
  readonly order: O;
  /** The keys, most significant first. */
  readonly keys: readonly (keyof O & string)[];
  /** The cursor of `row`: the next page starts right after it. */
  readonly encode: (row: CursorValues<O>) => string;
  /** The values inside a cursor. Throws a `TypeError` on a cursor this keyset did not make. */
  readonly decode: (cursor: string) => CursorValues<O>;
  /** Validates a cursor string sent by a client (it must decode). A string on both sides of the wire. */
  readonly cursor: z.ZodType<string, string>;
};

/** Tagged so a `Date` comes back a `Date`, not a string that happens to look like one. */
const encodedValue = z.union([
  z.tuple([z.literal('s'), z.string()]),
  z.tuple([z.literal('n'), z.number()]),
  z.tuple([z.literal('b'), z.boolean()]),
  z.tuple([z.literal('d'), z.iso.datetime()]),
]);

type EncodedValue = z.infer<typeof encodedValue>;

function encodeValue(key: string, value: CursorValue | null | undefined): EncodedValue {
  if (typeof value === 'string') return ['s', value];
  if (typeof value === 'number') return ['n', value];
  if (typeof value === 'boolean') return ['b', value];
  if (value instanceof Date) return ['d', value.toISOString()];
  // A NULL key has no place in the order: `x < NULL` is never true, so the next page would be empty.
  throw new TypeError(`[contracts] keyset: "${key}" is ${String(value)}; keyset keys must be NOT NULL columns.`);
}

function decodeValue([tag, value]: EncodedValue): CursorValue {
  return tag === 'd' ? new Date(value) : value;
}

/* ---- base64url over UTF-8: TextEncoder + btoa exist in every runtime we ship to ---- */

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.codePointAt(0) ?? 0));
}

/**
 * Declare how a list is ordered. Write it once in `model/` and use it in the
 * contract (`pageInput(storyOrder)`) and in the repository
 * (`keysetQuery(storyOrder, stories)` from `@arki/db/pagination`).
 *
 * End the order on a unique key (usually `id`); the cursor is the values of
 * these keys on the last row of a page, base64url-encoded JSON. It is opaque
 * to clients, not secret: a hand-made cursor only moves the start of a page,
 * it never skips the query's own filters (ownership included).
 *
 * @example
 * ```ts
 * export const storyOrder = keyset({ createdAt: 'desc', id: 'desc' });
 * const cursor = storyOrder.encode({ createdAt: row.createdAt, id: row.id });
 * storyOrder.decode(cursor);   // { createdAt: Date, id: 'sty_…' }
 * ```
 */
export function keyset<const O extends KeysetOrder>(order: O): Keyset<O> {
  // `Object.keys` is typed `string[]`; these are exactly the keys of `order`.
  const keys = Object.keys(order) as (keyof O & string)[];
  if (keys.length === 0) throw new TypeError('[contracts] keyset: declare at least one key, and end on a unique one.');

  const payload = z.array(encodedValue).length(keys.length);

  const decode = (cursor: string): CursorValues<O> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fromBase64Url(cursor));
    } catch (error) {
      throw new TypeError('[contracts] keyset: the cursor is not one this list made.', { cause: error });
    }
    const result = payload.safeParse(parsed);
    if (!result.success) throw new TypeError('[contracts] keyset: the cursor is not one this list made.');
    const values: Record<string, CursorValue> = {};
    for (const [index, key] of keys.entries()) {
      const encoded = result.data[index];
      if (encoded !== undefined) values[key] = decodeValue(encoded);
    }
    // Erasure seam: built key by key above; `payload` checked there is exactly one value per key.
    return values as CursorValues<O>;
  };

  const isCursor = (value: string): boolean => {
    try {
      decode(value);
      return true;
    } catch {
      return false;
    }
  };

  return {
    order,
    keys,
    encode: row => toBase64Url(JSON.stringify(keys.map(key => encodeValue(key, row[key])))),
    decode,
    // 1 KB is generous: a two-key cursor is about 80 characters.
    cursor: z.string().max(1024).refine(isCursor, { error: 'Invalid cursor' }),
  };
}

/** Limits for {@link pageInput}. */
export type PageInputOptions = {
  /** Page size when the client sends none. Default 20. */
  readonly defaultLimit?: number;
  /** The largest page a client may ask for. Default 100. */
  readonly maxLimit?: number;
};

/**
 * The input schema of a paged list: `{ cursor?, limit }`. No cursor means
 * the first page. Extend it with the list's own filters:
 * `pageInput(storyOrder).extend({ status: storyStatus })`.
 */
export function pageInput<O extends KeysetOrder>(order: Keyset<O>, options: PageInputOptions = {}) {
  const maxLimit = options.maxLimit ?? 100;
  return z.object({
    cursor: order.cursor.optional(),
    limit: z
      .int()
      .min(1)
      .max(maxLimit)
      .default(Math.min(options.defaultLimit ?? 20, maxLimit)),
  });
}

/**
 * The output schema of a paged list: the items and the cursor of the next
 * page, `null` on the last page — so "is there more?" is never a guess
 * from a full-looking page.
 */
export function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

/** One page of `T`, as {@link page} describes it. */
export type Page<T> = { readonly items: T[]; readonly nextCursor: string | null };
