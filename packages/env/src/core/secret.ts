/**
 * Secrets that cannot leak by accident.
 *
 * `secret(schema)` parses a variable as usual and wraps the result in a
 * {@link Redacted}. Printing it, logging it, serialising it or putting it in a
 * template string all show `[redacted]`. Reading the value takes a deliberate,
 * greppable `reveal(env.KEY)` call at the one place that needs it.
 *
 * Redaction guards against accidents (a logged config object, an error
 * message with the env in it). It is not encryption: code that calls
 * `reveal` gets the plain value.
 */
import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';

/** What a redacted value prints as, everywhere. */
const REDACTED_TEXT = '[redacted]';

/** Node's `util.inspect` hook, so `console.log(env)` shows `[redacted]` too. */
const inspect: unique symbol = Symbol.for('nodejs.util.inspect.custom');

/** Reads the private value. Assigned in the class's static block, so only this module can read it. */
let read: <Value>(redacted: Redacted<Value>) => Value;

/** A value that prints as `[redacted]`. Read it with {@link reveal}. */
export class Redacted<Value = string> {
  // A private field: invisible to JSON, `Object.keys`, spreading and `util.inspect`.
  readonly #value: Value;

  static {
    read = redacted => redacted.#value;
  }

  constructor(value: Value) {
    this.#value = value;
  }

  toString(): string {
    return REDACTED_TEXT;
  }

  toJSON(): string {
    return REDACTED_TEXT;
  }

  [inspect](): string {
    return REDACTED_TEXT;
  }
}

/** What {@link secret} returns: a Standard Schema whose output is redacted, with an `.optional()` variant. */
export type SecretSchema<Schema extends StandardSchemaV1> = StandardSchemaV1<
  SchemaInput<Schema>,
  Redacted<SchemaOutput<Schema>>
> & {
  /** Accepts a missing variable. `undefined` passes through as `undefined`, never redacted. */
  optional(): StandardSchemaV1<SchemaInput<Schema> | undefined, Redacted<SchemaOutput<Schema>> | undefined>;
};

/**
 * What every issue of a rejected secret says. Vendors such as valibot put the received value in
 * their messages (`Received "sk_live_…"`), and `defineEnv` logs and throws issues, so a secret's
 * issues keep only their path.
 */
const HIDDEN_ISSUE_MESSAGE = 'Invalid secret (details hidden so the value cannot leak)';

/**
 * Validate with `schema` (any Standard Schema), then wrap the value in a {@link Redacted}. For an
 * optional secret, call `.optional()`: `secret(z.string()).optional()`. The inner result passes
 * straight through: an async inner schema yields a promise, so `defineEnv`'s synchronous check
 * fails with the same `UnexpectedFailure` it would give without `secret`, and a throwing validator
 * still throws.
 *
 * @example
 * const env = defineEnv({ server: { STRIPE_KEY: secret(z.string().min(1)) } });
 * console.log(env.STRIPE_KEY);          // [redacted]
 * stripe(reveal(env.STRIPE_KEY));       // the key
 */
export function secret<Schema extends StandardSchemaV1>(schema: Schema): SecretSchema<Schema> {
  const { version, vendor } = schema['~standard'];
  type Sealed = StandardSchemaV1.Result<Redacted<SchemaOutput<Schema>>>;
  const seal = (result: StandardSchemaV1.Result<SchemaOutput<Schema>>): Sealed =>
    result.issues === undefined
      ? { value: new Redacted(result.value) }
      : {
          issues: result.issues.map(issue =>
            issue.path === undefined
              ? { message: HIDDEN_ISSUE_MESSAGE }
              : { message: HIDDEN_ISSUE_MESSAGE, path: issue.path },
          ),
        };
  const redact = (value: unknown): Sealed | Promise<Sealed> => {
    const result = schema['~standard'].validate(value);
    return result instanceof Promise ? result.then(seal) : seal(result);
  };
  return {
    '~standard': { version, vendor, validate: redact },
    optional: () => ({
      '~standard': {
        version,
        vendor,
        validate: value => (value === undefined ? { value: undefined } : redact(value)),
      },
    }),
  };
}

/**
 * The plain value of a secret. Also takes the raw value, because when
 * validation is skipped (`skipValidation`, or `CI` builds) schemas do not run
 * and the variable is still a plain string.
 */
export function reveal<Value>(value: Redacted<Value> | Value): Value {
  return value instanceof Redacted ? read(value) : value;
}
