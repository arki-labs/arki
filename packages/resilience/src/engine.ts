// The only module that talks to cockatiel. It turns a cockatiel policy into one of our
// `Policy` objects and turns cockatiel's errors into ours. Everything here is `@internal`:
// the build strips it from the published types, so no cockatiel name reaches them.

import type { IDefaultPolicyContext, IPolicy } from 'cockatiel';
import {
  isBrokenCircuitError as isCockatielBrokenCircuit,
  isBulkheadRejectedError as isCockatielBulkheadRejected,
  isTaskCancelledError as isCockatielTaskCancelled,
} from 'cockatiel';

import type { Policy, PolicyCallback, PolicyContext } from './policy.js';
import { BulkheadRejectedError, CancelledError, CircuitOpenError, TimeoutError } from './errors.js';

/** A cockatiel policy, whatever its context type. @internal */
export type Engine = IPolicy<IDefaultPolicyContext>;

/** The engine behind each policy this package created. */
const engines = new WeakMap<Policy, Engine>();

/** Retry supplies `attempt` in the context; the other policies do not. */
function hasAttempt(context: IDefaultPolicyContext): context is PolicyContext {
  return 'attempt' in context && typeof context.attempt === 'number';
}

/**
 * Turn a failure the engine raised into the matching error of this package. Errors thrown by
 * the wrapped function are returned as they are. Runs only when a call has already failed.
 * @internal
 */
export function toResilienceError(error: unknown, signal: AbortSignal | undefined): unknown {
  if (isCockatielBrokenCircuit(error)) {
    return new CircuitOpenError(error.message, { cause: error });
  }
  if (isCockatielBulkheadRejected(error)) {
    return new BulkheadRejectedError(error.message, { cause: error });
  }
  if (isCockatielTaskCancelled(error)) {
    // The engine uses one error for both: a deadline it set itself, and a signal the caller
    // aborted. Only the caller's signal tells them apart.
    return signal?.aborted
      ? new CancelledError('Operation cancelled by the caller', { cause: signal.reason ?? error })
      : new TimeoutError(error.message, { cause: error });
  }
  return error;
}

/** Build one of our policies on top of an engine, adding the engine's extra event methods. @internal */
export function fromEngine<Extra extends object>(engine: Engine, extra: Extra): Policy & Extra {
  const policy: Policy & Extra = {
    ...extra,
    onSuccess: engine.onSuccess,
    onFailure: engine.onFailure,
    async execute<T>(fn: PolicyCallback<T>, signal?: AbortSignal): Promise<T> {
      try {
        return await engine.execute(
          context => fn(hasAttempt(context) ? context : { signal: context.signal, attempt: 0 }),
          signal,
        );
      } catch (error) {
        throw toResilienceError(error, signal);
      }
    },
  };
  engines.set(policy, engine);
  return policy;
}

/** Lets a policy that was not created by this package take part in `wrap()`. */
class ForeignEngine implements Engine {
  declare readonly _altReturn: never;
  readonly onSuccess: Engine['onSuccess'];
  readonly onFailure: Engine['onFailure'];
  readonly #policy: Policy;

  constructor(policy: Policy) {
    this.#policy = policy;
    this.onSuccess = policy.onSuccess;
    this.onFailure = policy.onFailure;
  }

  execute<T>(fn: (context: IDefaultPolicyContext) => PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
    return this.#policy.execute(fn, signal);
  }
}

/** The engine behind a policy, or an adapter when the policy came from elsewhere. @internal */
export function engineOf(policy: Policy): Engine {
  return engines.get(policy) ?? new ForeignEngine(policy);
}
