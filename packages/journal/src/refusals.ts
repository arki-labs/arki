/**
 * The refusals one handler run was handed. A command run and an effect attempt each keep
 * one list, so a success after a refusal the handler did not handle is caught, and
 * `accept` marks one refusal as handled on purpose.
 * Leaf file: imports only `errors`, `rollback` and `types` (types).
 */
import type { Failure } from '@arki/failure';
import { isFailure } from '@arki/failure';

import type { AcceptFailure } from './types.js';
import { JournalError } from './errors.js';
import { isReturnedFailure } from './rollback.js';

/** One failure a write or run returned, and what returned it: the error message names it. */
export type Refusal = { readonly failure: Failure; readonly from: string };

/**
 * For one run of the handler of command or effect `name`. `sources` names what can hand it
 * a refusal, for the misuse message: `'write or run'` for a command, `'run'` for an effect.
 * - `watch(from)` passes a result through. A failure joins the pending list once per return,
 *   so the same object returned twice is two entries.
 * - `accept` removes the oldest pending entry for that very object. It throws
 *   `INVALID_ACCEPT` for a value that is not a failure, one this run never received, one
 *   already accepted, and for any call after `finish`.
 * - `unhandled()` is the oldest refusal still pending. A success is allowed only without one.
 * - `finish()` says the handler settled. From then on `accept` throws.
 */
export function trackRefusals(kind: 'command' | 'effect', name: string, sources: string) {
  const pending: Refusal[] = [];
  // Every failure ever received, to tell "already accepted" from "never received".
  const received = new Set<Failure>();
  let finished = false;
  const misuse = (detail: string) => new JournalError('INVALID_ACCEPT', kind, name, detail);
  const accept: AcceptFailure = failure => {
    if (finished) throw misuse('accept() was called after the handler finished');
    if (!isFailure<unknown>(failure)) throw misuse('accept() expects an @arki/failure value');
    const at = pending.findIndex(entry => entry.failure === failure);
    if (at !== -1) {
      pending.splice(at, 1);
      return;
    }
    throw misuse(
      received.has(failure)
        ? `the failure "${failure.code}" was already accepted`
        : `accept() was given the failure "${failure.code}", but no ${sources} of this ${kind} returned it`,
    );
  };
  return {
    watch:
      (from: string) =>
      <T>(value: T): T => {
        if (isReturnedFailure(value)) {
          pending.push({ failure: value, from });
          received.add(value);
        }
        return value;
      },
    accept,
    unhandled: (): Refusal | undefined => pending[0],
    finish: () => {
      finished = true;
    },
  };
}
