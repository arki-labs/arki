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
import type { ZodType } from 'zod';

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

/**
 * Parse with `schema`, then wrap the value in a {@link Redacted}. For an
 * optional secret, make the wrapped schema optional: `secret(z.string()).optional()`.
 *
 * @example
 * const env = defineEnv({ server: { STRIPE_KEY: secret(z.string().min(1)) } });
 * console.log(env.STRIPE_KEY);          // [redacted]
 * stripe(reveal(env.STRIPE_KEY));       // the key
 */
export function secret<Schema extends ZodType>(schema: Schema) {
  return schema.transform(value => new Redacted(value));
}

/**
 * The plain value of a secret. Also takes the raw value, because when
 * validation is skipped (`skipValidation`, or `CI` builds) schemas do not run
 * and the variable is still a plain string.
 */
export function reveal<Value>(value: Redacted<Value> | Value): Value {
  return value instanceof Redacted ? read(value) : value;
}
