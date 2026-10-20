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
export type Engine<E = never> = IPolicy<IDefaultPolicyContext, E>;

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

/** Runtime witness retains the engine's inferred alternate outcome without an erased WeakMap. */
class EnginePolicy<E> implements Policy<never, E> {
  readonly onSuccess: Engine<E>['onSuccess'];
  readonly onFailure: Engine<E>['onFailure'];

  constructor(readonly engine: Engine<E>) {
    this.onSuccess = engine.onSuccess;
    this.onFailure = engine.onFailure;
  }

  readonly execute = async <T>(fn: PolicyCallback<T>, signal?: AbortSignal): Promise<T | E> => {
    try {
      return await this.engine.execute(
        context => fn(hasAttempt(context) ? context : { signal: context.signal, attempt: 0 }),
        signal,
      );
    } catch (error) {
      throw toResilienceError(error, signal);
    }
  };
}

function isEnginePolicy<E>(policy: Policy<never, E>): policy is EnginePolicy<E> {
  return policy instanceof EnginePolicy;
}

/** Build one of our policies on top of an engine, adding the engine's extra event methods. @internal */
export function fromEngine<E, Extra extends object>(engine: Engine<E>, extra: Extra): Policy<never, E> & Extra {
  return Object.assign(new EnginePolicy(engine), extra);
}

/** Lets a policy that was not created by this package take part in `wrap()`. */
class ForeignEngine<E> implements Engine<E> {
  declare readonly _altReturn: E;
  readonly onSuccess: Engine['onSuccess'];
  readonly onFailure: Engine['onFailure'];
  readonly #policy: Policy<never, E>;

  constructor(policy: Policy<never, E>) {
    this.#policy = policy;
    this.onSuccess = policy.onSuccess;
    this.onFailure = policy.onFailure;
  }

  execute<T>(fn: (context: IDefaultPolicyContext) => PromiseLike<T> | T, signal?: AbortSignal): Promise<T | E> {
    return this.#policy.execute(fn, signal);
  }
}

/** The engine behind a policy, or an adapter when the policy came from elsewhere. @internal */
export function engineOf<E>(policy: Policy<never, E>): Engine<E> {
  return isEnginePolicy(policy) ? policy.engine : new ForeignEngine(policy);
}
