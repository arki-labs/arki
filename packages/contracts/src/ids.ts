import { z } from 'zod/v4';

/**
 * The id of a user: `usr_` followed by an id. Every package that refers to a user, whether or
 * not it owns the user table, uses this one type, so ids pass between packages without a
 * dependency between them.
 */
export type UserId = `usr_${string}`;

/** Validates a user id: a string that starts with `usr_`. */
export const userIdSchema = z.custom<UserId>(value => typeof value === 'string' && value.startsWith('usr_'), {
  message: 'Expected a user id: a string starting with "usr_"',
});

/* ------------------------------------------------------------------ */
/* defineId — a prefixed id, declared once                             */
/* ------------------------------------------------------------------ */

/**
 * One prefixed id kind, declared once: `export const storyId = defineId('sty_')`.
 * The prefix is the single source. The type, the zod schema and the generator
 * all come from it, so nobody writes `sty_` twice.
 *
 * Browser-safe on purpose: no Drizzle here. `@arki/db/id`'s `idColumns(storyId)`
 * turns the same declaration into table columns on the server.
 */
export type IdDeclaration<P extends string> = {
  /** The prefix every id of this kind starts with, exactly as stored (`'sty_'`). */
  readonly prefix: P;
  /** Validates an id of this kind. Its output type is the id type. */
  readonly schema: z.ZodType<`${P}${string}`>;
  /** A new random id: the prefix plus 24 lowercase letters and digits. */
  readonly create: () => `${P}${string}`;
  /** True when `value` is an id of this kind (a type guard, for code that has no schema at hand). */
  readonly is: (value: unknown) => value is `${P}${string}`;
};

/** The id type of a declaration: `type StoryId = IdOf<typeof storyId>` is `` `sty_${string}` ``. */
export type IdOf<D extends { readonly prefix: string }> = `${D['prefix']}${string}`;

/** Letters, digits and `_` only. Stored prefixes like `'pt'`, `'usr_'` and `'poet_notif_'` all pass. */
const PREFIX_PATTERN = /^\w+$/;

/**
 * Declare a prefixed id. The prefix is kept exactly as given, so a table
 * that already stores `hlgt_…` ids keeps working: switching a feature to
 * `defineId('hlgt_')` changes no stored value.
 *
 * @example
 * ```ts
 * // features/story/model/ids.ts — browser-safe, the contract can import it
 * export const storyId = defineId('sty_');
 * export type StoryId = IdOf<typeof storyId>;   // `sty_${string}`
 *
 * storyId.schema.parse('sty_k3…');              // StoryId
 * storyId.create();                             // 'sty_' + 24 random chars
 * ```
 */
export function defineId<const P extends string>(prefix: P): IdDeclaration<P> {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new TypeError(
      `[contracts] defineId: prefix "${prefix}" must be letters, digits or "_" (for example "sty_").`,
    );
  }
  const schema = z.templateLiteral([prefix, z.string()], {
    error: `Expected an id starting with "${prefix}"`,
  });
  return {
    prefix,
    schema,
    create: () => `${prefix}${randomBody()}`,
    is: (value: unknown): value is `${P}${string}` => typeof value === 'string' && value.startsWith(prefix),
  };
}

/* ---- the generator: Web Crypto, so it runs in Node, Bun, Deno and browsers ---- */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const ALPHABET = `${LETTERS}0123456789`;
const BODY_LENGTH = 24;

type RandomSource = { getRandomValues(array: Uint8Array): Uint8Array };

function hasRandomValues(value: unknown): value is RandomSource {
  return typeof value === 'object' && value !== null && 'getRandomValues' in value && typeof value.getRandomValues === 'function';
}

/** `globalThis.crypto`, read without DOM or Node typings. */
function randomSource(): RandomSource {
  const candidate: unknown = Reflect.get(globalThis, 'crypto');
  if (!hasRandomValues(candidate)) {
    // No Math.random fallback: ids end up in URLs, and guessable ones are a gift to the curious.
    throw new Error(
      '[contracts] defineId().create() needs globalThis.crypto.getRandomValues. In React Native, install a polyfill such as react-native-get-random-values.',
    );
  }
  return candidate;
}

/**
 * 24 characters shaped like a cuid2 (the format `@arki/db` ids already use):
 * a letter first, then letters and digits. Rejection sampling keeps every
 * character equally likely — `byte % 36` alone would favour the first few.
 */
function randomBody(): string {
  const source = randomSource();
  let out = '';
  while (out.length < BODY_LENGTH) {
    const bytes = source.getRandomValues(new Uint8Array(BODY_LENGTH * 2));
    for (const byte of bytes) {
      const alphabet = out.length === 0 ? LETTERS : ALPHABET;
      // Largest multiple of the alphabet size that fits in a byte: above it, the modulo is biased.
      const limit = 256 - (256 % alphabet.length);
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === BODY_LENGTH) break;
    }
  }
  return out;
}

/* ---- prefix uniqueness across an app ---- */

/** The prefixes that appear twice in a tuple of declarations (`never` when all differ). */
type DuplicatePrefixes<T extends readonly unknown[], Seen extends string = never> = T extends readonly [
  infer Head,
  ...infer Rest,
]
  ? Head extends { readonly prefix: infer P extends string }
    ? [P] extends [Seen]
      ? P | DuplicatePrefixes<Rest, Seen>
      : DuplicatePrefixes<Rest, Seen | P>
    : DuplicatePrefixes<Rest, Seen>
  : never;

type UniquePrefixGuard<T extends readonly unknown[]> = [DuplicatePrefixes<T>] extends [never]
  ? unknown
  : { readonly 'IDS: two declarations share a prefix': DuplicatePrefixes<T> };

/**
 * Check that no two id kinds of one app can be mistaken for each other.
 * Call it once with every declaration of the app — usually in a test.
 *
 * - Two declarations with the same prefix are a compile error (when the
 *   prefixes are literal types) and throw at runtime.
 * - A prefix that starts another one (`'sub'` and `'sub_'`) also throws:
 *   `sub_abc` passes both schemas, so the ids are not really distinct.
 *
 * @example
 * ```ts
 * // apps/novelette/backend/src/ids.test.ts
 * it('every id prefix is unique', () => assertUniqueIdPrefixes(storyId, podId, sceneId));
 * ```
 */
export function assertUniqueIdPrefixes<const T extends readonly IdDeclaration<string>[]>(
  ...ids: T & UniquePrefixGuard<T>
): void {
  const clashes: string[] = [];
  for (const [index, id] of ids.entries()) {
    for (const other of ids.slice(index + 1)) {
      if (id.prefix === other.prefix) clashes.push(`"${id.prefix}" is declared twice`);
      else if (other.prefix.startsWith(id.prefix)) clashes.push(`"${id.prefix}" is the start of "${other.prefix}"`);
      else if (id.prefix.startsWith(other.prefix)) clashes.push(`"${other.prefix}" is the start of "${id.prefix}"`);
    }
  }
  if (clashes.length > 0) {
    throw new Error(`[contracts] id prefixes overlap: ${clashes.join('; ')}. Give each id kind its own prefix.`);
  }
}
