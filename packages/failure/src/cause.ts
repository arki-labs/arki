/**
 * Cause chains, like Go's `errors.As`: a failure (or error) may carry a
 * `cause`, which may carry its own. `findCause` walks the chain.
 */
import type { StandardSchemaV1 } from '@arki/schema';

import type { DataOf, Failure, FailureDefinition } from './failure.js';

/** Longest chain `findCause` walks; deeper chains are almost certainly cycles. */
const MAX_DEPTH = 64;

/**
 * The first link in the cause chain, starting with `value` itself, that is a
 * failure of `definition` or an instance of the error class `kind`.
 *
 * @example
 * const synced = SyncFailed({ feed }, { cause: await readFeed(feed) });
 * const timeout = findCause(synced, DbTimeout); // typed DbTimeout failure, or undefined
 * const socket = findCause(error, ConnectionError); // a thrown error class works too
 */
export function findCause<Code extends string, Schema extends StandardSchemaV1 | undefined>(
  value: unknown,
  definition: FailureDefinition<Code, Schema>,
): Failure<Code, DataOf<Schema>> | undefined;
export function findCause<Instance>(
  value: unknown,
  kind: abstract new (...args: never[]) => Instance,
): Instance | undefined;
export function findCause(
  value: unknown,
  target: { readonly is: (value: unknown) => boolean } | (abstract new (...args: never[]) => unknown),
): unknown {
  const matches = 'is' in target ? target.is : (link: unknown) => link instanceof target;
  const seen = new Set<unknown>();
  let link = value;
  for (let depth = 0; depth < MAX_DEPTH && link !== undefined && !seen.has(link); depth++) {
    if (matches(link)) return link;
    seen.add(link);
    link = typeof link === 'object' && link !== null && 'cause' in link ? link.cause : undefined;
  }
  return undefined;
}
