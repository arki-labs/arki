// Internal execution keeps callback throws available to retry and explicit fallback.
// Only the public boundary normalizes a final defect. Each SDK adapter owns its refusals.
import type { IDefaultPolicyContext, IPolicy } from 'cockatiel';
import { UnexpectedDefect } from '@arki/failure';
import { is } from '@arki/schema';
import { z } from 'zod';

import type { ExecutionFailure } from './errors.js';
import type { Policy, PolicyCallback, PolicyContext, FailureReason, PolicyExecution } from './policy.js';
import { Cancelled } from './errors.js';
import { observeEvent } from './observers.js';

/** @internal */
export type Engine<E = never> = IPolicy<IDefaultPolicyContext, E | ExecutionFailure>;

const attemptSchema = z.object({ attempt: z.number() });
function contextOf(context: IDefaultPolicyContext): PolicyContext {
  return { signal: context.signal, attempt: is(context, attemptSchema) ? context.attempt : 0 };
}

// A private nominal carrier distinguishes a callback throw from an SDK refusal, even
// when the callback throws an actual SDK error. It never leaves the engine adapter.
class CallbackThrow extends Error {
  constructor(readonly original: unknown) { super('Callback threw'); }
}
const callbackThrowSchema = z.instanceof(CallbackThrow);
function originalError(error: unknown): unknown {
  return is(error, callbackThrowSchema) ? error.original : error;
}
/** @internal Keep public observations about the original callback, never the carrier. */
export function originalReason(reason: FailureReason): FailureReason {
  return 'error' in reason ? { error: originalError(reason.error) } : reason;
}

/** One adapter owns the source of each SDK refusal. */
class OwnedEngine<E> implements Engine<E> {
  declare readonly _altReturn: E | ExecutionFailure;
  readonly onSuccess;
  readonly onFailure: Engine<E>['onFailure'];
  constructor(readonly engine: IPolicy<IDefaultPolicyContext>, readonly refuse: (error: unknown) => E) {
    this.onSuccess = observeEvent(engine.onSuccess, engine);
    this.onFailure = listener => observeEvent(engine.onFailure, engine)(
      event => listener({ ...event, reason: originalReason(event.reason) }),
    );
  }
  async execute<T>(fn: (context: IDefaultPolicyContext) => PromiseLike<T> | T, signal?: AbortSignal) {
    if (signal?.aborted) return Cancelled({ cause: signal.reason });
    try {
      return await this.engine.execute(async context => {
        try {
          return await fn(context);
        } catch (error) {
          throw new CallbackThrow(error);
        }
      }, signal);
    } catch (error) {
      if (is(error, callbackThrowSchema)) throw error.original;
      try {
        return this.refuse(error);
      } catch (error_) {
        return UnexpectedDefect({ cause: error_ });
      }
    }
  }
}
/** @internal Protect callback provenance inside one engine, classify only its own refusal. */
export function ownedEngine<E>(engine: IPolicy<IDefaultPolicyContext>, refuse: (error: unknown) => E): Engine<E> {
  return new OwnedEngine(engine, refuse);
}

/** Public outcome supervision is separate from raw retry/fallback execution. */
class OwnedExecution<F, E> implements PolicyExecution<F, E> {
  constructor(readonly raw: PolicyExecution<F, E>) {}
  readonly execute = async <T>(fn: PolicyCallback<T>, signal?: AbortSignal): Promise<T | F | E | ExecutionFailure> => {
    try {
      return await executeRaw(this, fn, signal);
    } catch (error) {
      return UnexpectedDefect({ cause: error });
    }
  };
}
function isOwnedExecution<F, E>(policy: PolicyExecution<F, E>): policy is OwnedExecution<F, E> {
  return policy instanceof OwnedExecution;
}
/** @internal */
export function ownPolicy<F = never, E = never>(policy: Policy<F, E>): Policy<F, E> {
  return Object.assign(new OwnedExecution(policy), { onSuccess: policy.onSuccess, onFailure: policy.onFailure });
}
/** @internal Own an execution-only adapter, preserving raw fallback composition. */
export function ownExecution<F, E>(execution: PolicyExecution<F, E>): PolicyExecution<F, E> {
  return new OwnedExecution(execution);
}
/** @internal Raw fallback/retry composition; preflight never invokes cancelled work. */
export function executeRaw<T, F, E>(policy: PolicyExecution<F, E>, fn: PolicyCallback<T>, signal?: AbortSignal): Promise<T | F | E | ExecutionFailure> {
  if (signal?.aborted) return Promise.resolve(Cancelled({ cause: signal.reason }));
  return (isOwnedExecution(policy) ? policy.raw : policy).execute(fn, signal);
}
class EnginePolicy<E> extends OwnedExecution<never, E> implements Policy<never, E> {
  readonly onSuccess;
  readonly onFailure;
  constructor(readonly engine: Engine<E>) {
    super({
      execute: (fn, signal) => engine.execute(context => fn(contextOf(context)), signal),
    });
    this.onSuccess = engine.onSuccess;
    this.onFailure = engine.onFailure;
  }
}
function isEnginePolicy<E>(policy: Policy<never, E>): policy is EnginePolicy<E> {
  return policy instanceof EnginePolicy;
}
/** @internal */
export function fromEngine<E, Extra extends object>(engine: Engine<E>, extra: Extra): Policy<never, E> & Extra {
  return Object.assign(new EnginePolicy(engine), extra);
}
class ForeignEngine<E> implements Engine<E> {
  declare readonly _altReturn: E | ExecutionFailure;
  readonly onSuccess;
  readonly onFailure;
  constructor(readonly policy: Policy<never, E>) {
    this.onSuccess = observeEvent(policy.onSuccess, policy);
    this.onFailure = observeEvent(policy.onFailure, policy);
  }
  execute<T>(fn: (context: IDefaultPolicyContext) => PromiseLike<T> | T, signal?: AbortSignal) {
    return executeRaw(this.policy, fn, signal);
  }
}
/** @internal Composition retains raw callback throws without bypassing owned refusal classification. */
export function engineOf<E>(policy: Policy<never, E>): Engine<E> {
  return isEnginePolicy(policy) ? policy.engine : new ForeignEngine(policy);
}
