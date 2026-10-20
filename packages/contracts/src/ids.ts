import { z } from 'zod';

import type { FailureOf } from '@arki/failure';
import { isFailure, UnexpectedDefect } from '@arki/failure';

import { CONTRACTS_ERROR_CODES, ContractsError, RandomSourceUnavailable } from './errors.js';

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
export type IdDeclaration<P extends string> = ReturnType<typeof defineId<P>>;

/** Canonical failures returned by ID generation, including unexpected provider faults. */
export const ID_GENERATION_FAILURES = [RandomSourceUnavailable, UnexpectedDefect] as const;

/** The exact failure union derived from the canonical generation definitions. */
export type IdGenerationFailure = FailureOf<(typeof ID_GENERATION_FAILURES)[number]>;

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
 * storyId.create();                             // StoryId | IdGenerationFailure
 * ```
 */
export function defineId<const P extends string>(prefix: P) {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new ContractsError(
      CONTRACTS_ERROR_CODES.invalidIdPrefix,
      `defineId: prefix "${prefix}" must be letters, digits or "_" (for example "sty_").`,
    );
  }
  const schema = z.templateLiteral([prefix, z.string()], {
    error: `Expected an id starting with "${prefix}"`,
  });
  return {
    /** The stored prefix, unchanged. */
    prefix,
    /** Validates successful IDs; generation failures never enter the schema type. */
    schema,
    /** A new prefixed ID, or a canonical failure when secure generation cannot finish. */
    create: (): `${P}${string}` | IdGenerationFailure => {
      const body = randomBody();
      return isFailure(body) ? body : `${prefix}${body}`;
    },
    /** Tests the prefix and narrows to the success-only ID type. */
    is: (value: unknown): value is `${P}${string}` => typeof value === 'string' && value.startsWith(prefix),
  } as const;
}

/* ---- the generator: Web Crypto, so it runs in Node, Bun, Deno and browsers ---- */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const ALPHABET = `${LETTERS}0123456789`;
const BODY_LENGTH = 24;

const RANDOM_BATCH_SIZE = BODY_LENGTH * 2;
// 1536 samples give rejection sampling ample room, while broken providers cannot loop forever.
const MAX_RANDOM_BATCHES = 32;

/**
 * 24 characters shaped like a cuid2: a letter first, then letters and digits.
 * Rejection sampling keeps each character equally likely. Only our fixed-size
 * buffer is read, by index, so provider-owned iterators cannot control the loop.
 */
function randomBody(): string | IdGenerationFailure {
  try {
    const source: unknown = Reflect.get(globalThis, 'crypto');
    if (typeof source !== 'object' || source === null) return RandomSourceUnavailable();
    const getRandomValues: unknown = Reflect.get(source, 'getRandomValues');
    if (typeof getRandomValues !== 'function') return RandomSourceUnavailable();
    let out = '';
    for (let batch = 0; batch < MAX_RANDOM_BATCHES; batch++) {
      const bytes = new Uint8Array(RANDOM_BATCH_SIZE);
      // Web Crypto requires its receiver and returns the exact buffer passed in.
      const result: unknown = Reflect.apply(getRandomValues, source, [bytes]);
      if (result !== bytes) {
        // A broken synchronous provider may still return rejected asynchronous work.
        // Observe it without delaying this protocol failure or exposing its private cause.
        void Promise.resolve(result).catch(() => {
          // The synchronous protocol failure below already owns this outcome.
        });
        return UnexpectedDefect({ cause: new TypeError('Random provider returned a different buffer.') });
      }
      for (let index = 0; index < RANDOM_BATCH_SIZE; index++) {
        const byte = bytes[index];
        if (byte === undefined)
          return UnexpectedDefect({ cause: new TypeError('Random provider detached its buffer.') });
        const alphabet = out.length === 0 ? LETTERS : ALPHABET;
        const limit = 256 - (256 % alphabet.length);
        if (byte >= limit) continue;
        out += alphabet[byte % alphabet.length];
        if (out.length === BODY_LENGTH) return out;
      }
    }
    return UnexpectedDefect({ cause: new Error('Random provider exhausted the rejection sampling budget.') });
  } catch (error) {
    return UnexpectedDefect({ cause: error });
  }
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
 * // apps/my-app/backend/src/ids.test.ts
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
    throw new ContractsError(
      CONTRACTS_ERROR_CODES.overlappingIdPrefixes,
      `id prefixes overlap: ${clashes.join('; ')}. Give each id kind its own prefix.`,
    );
  }
}
