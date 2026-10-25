import { init as initCuid } from '@paralleldrive/cuid2';
import { z } from 'zod';

import type { FailureOf } from '@arki/failure';
import { isFailure, UnexpectedDefect } from '@arki/failure';

import { is, recordSchema } from '@arki/schema';
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
export type IdDeclaration<P extends string> = ReturnType<typeof prefixedId<P>>;

/** Canonical failures returned by ID generation, including unexpected provider faults. */
export const ID_GENERATION_FAILURES = [RandomSourceUnavailable, UnexpectedDefect] as const;

/** The exact failure union derived from the canonical generation definitions. */
export type IdGenerationFailure = FailureOf<(typeof ID_GENERATION_FAILURES)[number]>;

/** The successful ID inferred from its canonical schema, including any domain brand. */
export type IdOf<D extends { readonly schema: z.ZodType }> = z.output<D['schema']>;

// A runtime choice of two kinds would brand one value as both domains in Zod.
type SingleKind<Kind extends string, All = Kind> = Kind extends ''
  ? never
  : Kind extends unknown
    ? [All] extends [Kind]
      ? Kind
      : never
    : never;

// Parse once at definition time: generation closes over a frozen copy, never caller state.
const customIdFormatSchema = z
  .strictObject({
    alphabet: z
      .string()
      .min(2)
      .max(256)
      .refine(alphabet => !/[\uD800-\uDFFF]/u.test(alphabet) && new Set(alphabet).size === alphabet.length),
    length: z.number().int().min(1).max(256),
  })
  .readonly();

type IdFormat = 'uuid' | z.output<typeof customIdFormatSchema>;

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
export function defineId<const P extends string>(prefix: P): ReturnType<typeof prefixedId<P>>;
/**
 * Give same-format IDs distinct domain types without changing their stored values.
 * `format: 'uuid'` generates UUID v4; `{ alphabet, length }` uniformly samples
 * 1–256 characters from 2–256 distinct, non-surrogate UTF-16 characters.
 * The format is copied and frozen at definition time. Omitting it keeps the
 * default 24-character body. Schemas still validate only the stored prefix.
 */
export function defineId<const P extends string, const Kind extends string>(
  prefix: P,
  options: {
    readonly kind: Kind & (Record<never, never> extends Record<Kind, never> ? never : SingleKind<Kind>);
    readonly format?: IdFormat;
  },
): ReturnType<typeof brandedId<P, Kind>>;
export function defineId(prefix: string, options?: unknown) {
  if (typeof prefix !== 'string') {
    throw new ContractsError(
      CONTRACTS_ERROR_CODES.invalidIdPrefix,
      'defineId: prefix must be a string. Use an empty string for unprefixed stored IDs.',
    );
  }
  if (options === undefined) return prefixedId(prefix);
  const kind: unknown = is(options, recordSchema) ? Reflect.get(options, 'kind') : undefined;
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new ContractsError(
      CONTRACTS_ERROR_CODES.invalidIdKind,
      'defineId: kind must be a non-empty domain name. Use one literal name for each identity kind.',
    );
  }
  const format: unknown = is(options, recordSchema) ? Reflect.get(options, 'format') : undefined;
  if (format === undefined || format === 'uuid') return brandedId(prefix, kind, format);
  return brandedId(prefix, kind, snapshotIdFormat(format));
}

function snapshotIdFormat(format: unknown) {
  try {
    return customIdFormatSchema.parse(format);
  } catch (error) {
    throw new ContractsError(CONTRACTS_ERROR_CODES.invalidIdFormat, 'defineId: invalid generation format.', {
      cause: error,
    });
  }
}

function prefixedIdSchema<const P extends string>(prefix: P) {
  return z.templateLiteral([prefix, z.string()], {
    error: `Expected an id starting with "${prefix}"`,
  });
}

function prefixedId<const P extends string>(prefix: P) {
  // Name the id type here. Zod infers a deferred conditional for a generic prefix, and a
  // dependent's emitted `.d.ts` (`createTombstoneTable<TPrefix>` in `@arki/ai`) printed it as `never`.
  // The branded path keeps Zod's type: TypeScript drops a generic `.brand<Kind>()` on this
  // annotated schema to `idDeclaration`'s constraint, which erases the brand.
  const schema: z.ZodTemplateLiteral<`${P}${string}`> = prefixedIdSchema(prefix);
  return idDeclaration(prefix, schema);
}

function brandedId<const P extends string, const Kind extends string>(prefix: P, _kind: Kind, format?: IdFormat) {
  return idDeclaration(prefix, prefixedIdSchema(prefix).brand<Kind>(), format);
}

function idDeclaration<const P extends string, TSchema extends z.ZodType<`${P}${string}`>>(
  prefix: P,
  schema: TSchema,
  format?: IdFormat,
) {
  // The same schema with zod's generated fast path; parsing an id is on every
  // request path (`requestId.is(header)`, `requestId.create()`).
  const fast = z.compile(schema);
  return {
    /** The stored prefix, unchanged. */
    prefix,
    /** Validates successful IDs; generation failures never enter the schema type. */
    schema,
    /** A new prefixed ID, or a canonical failure when secure generation cannot finish. */
    create: (): z.output<typeof schema> | IdGenerationFailure => {
      const body =
        format === 'uuid'
          ? createUuidBody()
          : format === undefined
            ? createIdBody()
            : createRandomBody(format.length, format.alphabet, format.alphabet);
      if (isFailure(body)) return body;
      try {
        const result = fast.safeParse(`${prefix}${body}`);
        return result.success ? result.data : UnexpectedDefect({ cause: result.error });
      } catch (error) {
        return UnexpectedDefect({ cause: error });
      }
    },
    /** Validates the canonical schema and narrows to its success-only domain type. */
    is: (value: unknown): value is z.output<typeof schema> =>
      typeof value === 'string' && fast.safeParse(value).success,
  } as const;
}

/* ---- the generator: Web Crypto, so it runs in Node, Bun, Deno and browsers ---- */

const BODY_LENGTH = 24;

// Each batch samples twice the target length; 32 batches bound broken providers.
const MAX_RANDOM_BATCHES = 32;

/**
 * Draws 32 random bits from the provider `createIdBody` resolved for the
 * current generation. Set for the span of one generation, read by cuid2's
 * `random` callback; cleared after, so a draw outside a generation fails.
 */
let activeDraw: ((bytes: Uint32Array) => unknown) | undefined;

/** cuid2's `random`: a float in [0, 1) from the active Web Crypto provider, or a thrown protocol violation. */
function secureRandom(): number {
  const draw = activeDraw;
  if (draw === undefined) throw new TypeError('Random draw outside of an id generation.');
  const bytes = new Uint32Array(1);
  const result: unknown = draw(bytes);
  if (result !== bytes) {
    // A broken synchronous provider may still return rejected asynchronous work.
    // Observe it without delaying this protocol failure or exposing its private cause.
    void Promise.resolve(result).catch(() => {
      // The synchronous protocol failure below already owns this outcome.
    });
    throw new TypeError('Random provider returned a different buffer.');
  }
  const value = bytes[0];
  if (value === undefined) throw new TypeError('Random provider detached its buffer.');
  return value / 4_294_967_296;
}

/** The cuid2 generator, seeded (counter, host fingerprint) on the first successful generation. */
let cuid: (() => string) | undefined;

/**
 * Generate the unprefixed body shared by modern declarations and legacy DB IDs.
 * This is an entropy primitive, not a domain identity declaration: use `defineId`
 * to associate a body with its schema and ID kind.
 *
 * The body is a cuid2 (`@paralleldrive/cuid2`): 24 characters, a letter
 * first, then letters and digits; a SHA3 of time, a counter, a host
 * fingerprint and random salt. Every random bit comes from Web Crypto's
 * `getRandomValues`, resolved per generation: an unusable provider answers
 * `RandomSourceUnavailable`, a provider that breaks the protocol answers
 * `UnexpectedDefect`, and no provider-owned value is ever iterated.
 *
 * A cuid2 costs about 100 µs on Bun and Node (the hash and the base-36
 * conversion), so it is for entity identities, not per-request ids;
 * `format: 'uuid'` stays at well under a microsecond.
 */
export function createIdBody(): string | IdGenerationFailure {
  try {
    const source: unknown = Reflect.get(globalThis, 'crypto');
    if (typeof source !== 'object' || source === null) return RandomSourceUnavailable();
    const getRandomValues: unknown = Reflect.get(source, 'getRandomValues');
    if (typeof getRandomValues !== 'function') return RandomSourceUnavailable();
    // Web Crypto requires its receiver.
    activeDraw = bytes => Reflect.apply(getRandomValues, source, [bytes]);
    try {
      cuid ??= initCuid({ random: secureRandom, length: BODY_LENGTH });
      return cuid();
    } finally {
      activeDraw = undefined;
    }
  } catch (error) {
    return UnexpectedDefect({ cause: error });
  }
}

function createRandomBody(length: number, firstAlphabet: string, alphabet: string): string | IdGenerationFailure {
  try {
    const source: unknown = Reflect.get(globalThis, 'crypto');
    if (typeof source !== 'object' || source === null) return RandomSourceUnavailable();
    const getRandomValues: unknown = Reflect.get(source, 'getRandomValues');
    if (typeof getRandomValues !== 'function') return RandomSourceUnavailable();
    let out = '';
    const batchSize = length * 2;
    for (let batch = 0; batch < MAX_RANDOM_BATCHES; batch++) {
      const bytes = new Uint8Array(batchSize);
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
      for (let index = 0; index < batchSize; index++) {
        const byte = bytes[index];
        if (byte === undefined)
          return UnexpectedDefect({ cause: new TypeError('Random provider detached its buffer.') });
        const characters = out.length === 0 ? firstAlphabet : alphabet;
        const limit = 256 - (256 % characters.length);
        if (byte >= limit) continue;
        out += characters[byte % characters.length];
        if (out.length === length) return out;
      }
    }
    return UnexpectedDefect({ cause: new Error('Random provider exhausted the rejection sampling budget.') });
  } catch (error) {
    return UnexpectedDefect({ cause: error });
  }
}

// Generation format does not constrain schemas: restored external keys keep their bytes.
function createUuidBody(): string | IdGenerationFailure {
  try {
    const source: unknown = Reflect.get(globalThis, 'crypto');
    if (typeof source !== 'object' || source === null) return RandomSourceUnavailable();
    const randomUUID: unknown = Reflect.get(source, 'randomUUID');
    if (typeof randomUUID !== 'function') {
      const getRandomValues: unknown = Reflect.get(source, 'getRandomValues');
      if (typeof getRandomValues !== 'function') return RandomSourceUnavailable();
      const bytes = new Uint8Array(16);
      const result: unknown = Reflect.apply(getRandomValues, source, [bytes]);
      if (result !== bytes) {
        void Promise.resolve(result).catch(() => {
          // The synchronous protocol failure below already owns this outcome.
        });
        return UnexpectedDefect({ cause: new TypeError('Random provider returned a different buffer.') });
      }
      let hex = '';
      for (let index = 0; index < 16; index++) {
        const byte = bytes[index];
        if (byte === undefined)
          return UnexpectedDefect({ cause: new TypeError('Random provider detached its buffer.') });
        // RFC 9562: retain random bits except the UUID-v4 version and variant.
        const value =
          index === 6 ? (byte & 0b0000_1111) | 0b0100_0000 : index === 8 ? (byte & 0b0011_1111) | 0b1000_0000 : byte;
        hex += value.toString(16).padStart(2, '0');
      }
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    const result: unknown = Reflect.apply(randomUUID, source, []);
    if (
      typeof result === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)
    ) {
      return result;
    }
    // Observe asynchronous protocol violations while returning the synchronous failure.
    void Promise.resolve(result).catch(() => {
      // The synchronous protocol failure below already owns this outcome.
    });
    return UnexpectedDefect({ cause: new TypeError('Random UUID provider returned an invalid UUID v4.') });
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
