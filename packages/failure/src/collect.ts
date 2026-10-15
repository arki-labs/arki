/**
 * Many values at once: split them (`partition`), or take all successes or the
 * first failure (`collect`).
 */
import type { Failure } from './failure.js';
import { isFailure } from './failure.js';

/**
 * Split values into successes and failures, each in input order.
 *
 * @example
 * const [posts, missing] = partition(await Promise.all(ids.map(find)));
 * //     ^? Post[]  ^? Failure<'post.not_found', …>[]
 */
export function partition<Value>(values: Iterable<Value>): [Exclude<Value, Failure>[], Extract<Value, Failure>[]];
export function partition(values: Iterable<unknown>): [unknown[], unknown[]] {
  const successes: unknown[] = [];
  const failures: unknown[] = [];
  for (const value of values) (isFailure(value) ? failures : successes).push(value);
  return [successes, failures];
}

/**
 * Every success, or the first failure. Typed per position like `Promise.all`.
 *
 * @example
 * const both = collect(await Promise.all([find(a), findAuthor(b)]));
 * //    ^? [Post, Author] | Failure<'post.not_found', …> | Failure<'author.banned', …>
 */
export function collect<const Values extends readonly unknown[]>(
  values: Values,
): { -readonly [Key in keyof Values]: Exclude<Values[Key], Failure> } | Extract<Values[number], Failure>;
export function collect(values: readonly unknown[]): unknown {
  return values.find(value => isFailure(value)) ?? [...values];
}
