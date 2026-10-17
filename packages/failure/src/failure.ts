/**
 * Expected failures as values.
 *
 * A failure is something the caller should handle: "post not found", "email
 * taken", "card declined". `defineFailure` names one kind of failure once;
 * calling the definition makes a failure value; a function returns it like
 * any other value. The return type is inferred as `Post | Failure<'post.not_found', …>`,
 * so the compiler makes every caller check before using the post.
 *
 * Bugs are not failures. A bug still throws.
 */
import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';

import { FAILURE_ERROR_CODES, FailureError } from './errors.js';

/**
 * The brand every failure carries. A string key, like Standard Schema's
 * `~standard`: it survives duplicated package copies and realms, sorts last in
 * autocomplete, and lets the `must-use` lint rule see failures in a type.
 * At runtime it is non-enumerable, so JSON and spreads never show it.
 */
const BRAND = '~failure';

/** An expected failure, returned as a value. Made by calling a {@link FailureDefinition}. */
export type Failure<Code extends string = string, Data = unknown> = {
  /** Stable, unique code, such as `post.not_found`. Match on it, never on the message. */
  readonly code: Code;
  /** What went wrong, for people. */
  readonly message: string;
  /** The facts the caller needs to handle it, such as the id that was not found. */
  readonly data: Data;
  /** The HTTP status a boundary answers with: 400–599. */
  readonly status: number;
  /** What the caller can do about it, in one sentence. */
  readonly remediation: string | undefined;
  /** What caused it: a lower-level failure or a caught error. Walk the chain with `findCause`. */
  readonly cause?: unknown;
  readonly [BRAND]: true;
};

/**
 * The data a definition's failures carry: the schema's output type, the live
 * value the failure carries; `undefined` without a schema.
 */
export type DataOf<Schema> = Schema extends StandardSchemaV1 ? SchemaOutput<Schema> : undefined;

/** What making one failure may take besides its data. */
export type MakeOptions = {
  /** What caused this failure: a lower-level failure or a caught error. */
  readonly cause?: unknown;
};

/** The arguments a definition takes: the data when it has a schema, then optional `{ cause }`. */
type MakeArgs<Schema> = Schema extends StandardSchemaV1
  ? undefined extends DataOf<Schema>
    ? [data?: DataOf<Schema>, options?: MakeOptions]
    : [data: DataOf<Schema>, options?: MakeOptions]
  : [options?: MakeOptions];

/** One kind of failure. Call it to make a failure value. */
export type FailureDefinition<
  Code extends string = string,
  Schema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  /** Make a failure of this kind. */
  (...args: MakeArgs<Schema>): Failure<Code, DataOf<Schema>>;
  readonly code: Code;
  readonly status: number;
  readonly remediation: string | undefined;
  /** The schema of the data, for boundaries that send failures over the wire (oRPC error maps, `revive`). */
  readonly dataSchema: Schema;
  /** True when `value` is a failure with this definition's code. */
  is(value: unknown): value is Failure<Code, DataOf<Schema>>;
};

/** The `{name}` placeholders of a message template. */
type Placeholders<Message extends string> = Message extends `${string}{${infer Key}}${infer Rest}`
  ? Key | Placeholders<Rest>
  : never;

/** The message, or a readable type error naming the placeholder that is not a key of the data. */
type CheckedMessage<Message extends string, Data> = [Exclude<Placeholders<Message>, keyof Data & string>] extends [
  never,
]
  ? Message
  : `unknown placeholder {${Exclude<Placeholders<Message>, keyof Data & string>}}: not a key of the data`;

/** What `defineFailure` takes besides the code. */
export type FailureOptions<Schema extends StandardSchemaV1 | undefined, Message extends string = string> = {
  /** Schema of the data the failure carries: any Standard Schema (Zod 4, Valibot, ArkType). */
  readonly data?: Schema;
  /**
   * What the failure says. A template such as `'no post {id}'` fills each
   * `{key}` from the data, and a placeholder that is not a key of the data is
   * a type error. A function builds the message from the data. Defaults to the code.
   */
  readonly message?: CheckedMessage<Message, DataOf<Schema>> | ((data: DataOf<Schema>) => string);
  /** HTTP status at a boundary, 400–599. Defaults to 400: an expected failure is the caller's to handle, not a server bug. */
  readonly status?: number;
  /** What the caller can do about it, in one sentence. */
  readonly remediation?: string;
};

/**
 * Name one kind of expected failure. The code, the data type and the message
 * are written here once; every failure value, `match` handler, oRPC error map
 * and `revive` takes its types from this definition.
 *
 * @example
 * export const PostNotFound = defineFailure('post.not_found', {
 *   status: 404,
 *   data: z.object({ id: PostId }),
 *   message: 'no post {id}',
 * });
 *
 * const find = async (id: PostId) => (await repo.find(id)) ?? PostNotFound({ id });
 * //    ^? (id: PostId) => Promise<Post | Failure<'post.not_found', { id: PostId }>>
 */
export function defineFailure<
  const Code extends string,
  Schema extends StandardSchemaV1 | undefined = undefined,
  const Message extends string = string,
>(code: Code, options?: FailureOptions<Schema, Message>): FailureDefinition<Code, Schema>;
export function defineFailure(code: string, options: LooseOptions = {}): unknown {
  if (code === '' || code === 'ok') {
    throw new FailureError(
      FAILURE_ERROR_CODES.invalidCode,
      `defineFailure() needs a non-empty code other than "ok", got ${JSON.stringify(code)}`,
      'Use a stable dotted code such as "post.not_found"; "ok" is reserved for the success branch of match().',
    );
  }
  const status = options.status ?? 400;
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new FailureError(
      FAILURE_ERROR_CODES.invalidStatus,
      `defineFailure("${code}") needs a status from 400 to 599, got ${String(status)}`,
      'Pick the HTTP status a client should see: 4xx when the caller can fix it, 5xx when it cannot.',
    );
  }
  const { message, remediation, data: dataSchema } = options;
  const hasData = dataSchema !== undefined;

  const make = (...args: readonly unknown[]): Failure => {
    const data = hasData ? args[0] : undefined;
    const text = typeof message === 'function' ? message(data) : fill(message ?? code, data);
    return new FailureValue(code, text, data, status, remediation, causeOf(hasData ? args[1] : args[0]));
  };
  const is = (value: unknown): boolean => isFailure(value) && value.code === code;

  return Object.freeze(Object.assign(make, { code, status, remediation, dataSchema, is }));
}

/**
 * The runtime shape of every failure. Own fields are the JSON a failure
 * serialises to; the brand and `cause` are prototype getters, so JSON, spreads
 * and `Object.keys` never show them, while `'~failure' in value` still sees the brand.
 */
class FailureValue {
  readonly code: string;
  readonly message: string;
  readonly data: unknown;
  readonly status: number;
  readonly remediation: string | undefined;
  readonly #cause: unknown;

  constructor(
    code: string,
    message: string,
    data: unknown,
    status: number,
    remediation: string | undefined,
    cause: unknown,
  ) {
    this.code = code;
    this.message = message;
    this.data = data;
    this.status = status;
    this.remediation = remediation;
    this.#cause = cause;
    Object.freeze(this);
  }

  /** The brand lives on the prototype (below), so it never appears in JSON or spreads. */
  declare readonly [BRAND]: true;

  get cause(): unknown {
    return this.#cause;
  }
}
Object.defineProperty(FailureValue.prototype, BRAND, { value: true });

/** The `cause` of a definition call's options argument, if it has one. */
function causeOf(options: unknown): unknown {
  return typeof options === 'object' && options !== null && 'cause' in options ? options.cause : undefined;
}

/** The implementation's view of the options: the overload above carries the precise types. */
type LooseOptions = {
  readonly data?: StandardSchemaV1;
  readonly message?: string | ((data: unknown) => string);
  readonly status?: number;
  readonly remediation?: string;
};

/** Fill `{key}` placeholders from the data; a placeholder with no value stays as written. */
function fill(template: string, data: unknown): string {
  if (typeof data !== 'object' || data === null) return template;
  const values: Readonly<Record<string, unknown>> = { ...data };
  return template.replaceAll(/\{([^{}]+)\}/g, (placeholder, key: string) =>
    key in values ? String(values[key]) : placeholder,
  );
}

/** Refuses a promise: `isFailure(find(id))` is always false, so it must be awaited first. */
export type AwaitFirst<Value> = [Value] extends [PromiseLike<unknown>]
  ? [error: 'await the value first: a promise is never a failure']
  : [];

/** The failures in `Value`, or any failure when `Value` is `unknown`. */
export type FailureIn<Value> = unknown extends Value ? Value & Failure : Extract<Value, Failure>;

/**
 * True when `value` is a failure made by any {@link FailureDefinition}.
 * Narrows `T | Failure` both ways. Passing a promise is a type error: await it first.
 */
export function isFailure<Value>(value: Value, ...awaitFirst: AwaitFirst<Value>): value is FailureIn<Value>;
export function isFailure(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  // The brand lives only on the failure prototype. JSON.parse and object literals can set
  // it as an own property but never on a prototype, so outside data (an API response, a
  // queue message, a tool result) can never pass as a failure. Checked by shape, not
  // instanceof, so two copies of this package still recognise each other's failures.
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    typeof prototype === 'object' &&
    prototype !== null &&
    Object.hasOwn(prototype, BRAND) &&
    !Object.hasOwn(value, BRAND)
  );
}

/** A value that may be a failure: the success value, or one of the failures it can return. */
export type Result<Value, Failures extends Failure = never> = Value | Failures;

/**
 * A partial success: the value, plus the failure that stopped the work early when one did.
 * Callers read `result.stoppedBy` directly, with no `'stoppedBy' in result` check.
 *
 * @example
 * async function exportAll(items: Item[]): Promise<Stoppable<{ delivered: Item[] }, FailureOf<typeof send>>> {
 *   const delivered: Item[] = [];
 *   for (const item of items) {
 *     const sent = await send(item);
 *     if (isFailure(sent)) return { delivered, stoppedBy: sent };
 *     delivered.push(item);
 *   }
 *   return { delivered };
 * }
 */
export type Stoppable<Value, Failures extends Failure> = Value & { readonly stoppedBy?: Failures };

/** The failures a function can return, for sync and async functions: `FailureOf<typeof findPost>`. */
export type FailureOf<Fn extends (...args: never[]) => unknown> = Extract<Awaited<ReturnType<Fn>>, Failure>;

/** The success value a function returns, without its failures: `SuccessOf<typeof findPost>`. */
export type SuccessOf<Fn extends (...args: never[]) => unknown> = Exclude<Awaited<ReturnType<Fn>>, Failure>;

/** A failure thrown because the code decided it cannot happen: what {@link orThrow} throws. */
export class UnexpectedFailure<F extends Failure = Failure> extends Error {
  readonly failure: F;
  readonly code: F['code'];
  readonly status: number;
  readonly remediation: string | undefined;

  constructor(failure: F) {
    super(`${failure.code}: ${failure.message}`, { cause: failure.cause });
    this.name = 'UnexpectedFailure';
    this.failure = failure;
    this.code = failure.code;
    this.status = failure.status;
    this.remediation = failure.remediation;
  }
}

/**
 * The value, or throw the failure as an {@link UnexpectedFailure}. For places
 * where a failure is a bug: a seed script, a test, an id you just created.
 * Takes a promise too, so `orThrow(find(id))` cannot forget the `await`.
 */
export function orThrow<Value>(value: PromiseLike<Value>): Promise<Exclude<Value, Failure>>;
export function orThrow<Value>(value: Value): Exclude<Value, Failure>;
export function orThrow(value: unknown): unknown {
  if (isThenable(value)) return Promise.resolve(value).then(orThrowNow);
  return orThrowNow(value);
}

function orThrowNow(value: unknown): unknown {
  if (isFailure(value)) throw new UnexpectedFailure(value);
  return value;
}

/** @internal True for promises and other thenables. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}
