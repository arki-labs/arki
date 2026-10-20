/**
 * A returned failure rolls its transaction back. Drizzle rolls back only when the
 * callback throws, so the failure leaves the transaction as a private signal and
 * comes back as the result right outside it. `write` uses it; command transactions use @arki/db ownership.
 * Leaf file: imports nothing from this package.
 */
import type { Failure } from '@arki/failure';
import { isFailure } from '@arki/failure';

/**
 * `isFailure` for a value whose type is still generic, where `isFailure` cannot check that
 * it is not a promise. Narrows to the failures in `Value`. Not for `unknown`: it has none.
 */
export const isReturnedFailure = <Value>(value: Value): value is Extract<Value, Failure> => isFailure<unknown>(value);

/**
 * For one transaction (or savepoint) whose callback resolves with a `T`:
 * `source.transaction(async tx => settle(value)).catch(recover)`.
 * - `settle(value)`, inside the callback, returns `value`; when `value` is a failure
 *   (`@arki/failure`) it throws instead, so the transaction rolls back.
 * - `recover`, on the transaction's promise, turns that throw back into the failure,
 *   the same instance. Any other error passes through.
 */
export function rollbackOnFailure<T>() {
  // One signal per transaction, so a nested one never catches the signal of the one around it.
  const signal = new Error('journal: a returned failure is rolling back its transaction');
  const held: { failure?: { readonly value: T } } = {};
  return {
    settle: (value: T): T => {
      if (!isReturnedFailure(value)) return value;
      held.failure = { value };
      throw signal;
    },
    recover: (error: unknown): T => {
      if (error === signal && held.failure !== undefined) return held.failure.value;
      throw error;
    },
  };
}
