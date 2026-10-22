/**
 * The `$handlers` kernel key: one handler call becomes `starting`, then
 * `completed` or `failed`, fanned out to the app's lifecycle observers.
 *
 * Transport adapters (rpc, http, job, schedule) wrap each call in `run`; this
 * file owns the one rule for what an outcome is, so the transports agree:
 * a returned `Failure` is a refusal (`completed/refused`), a throw is `failed`,
 * unless the transport's `outcome` reads its own values or throws differently.
 */

import type { Failure } from '@arki/failure';
import { isFailure } from '@arki/failure';

import type { DotHandlerLifecycleEvent } from '../lifecycle-observer.js';
import type { DotHandlerObserver } from '../unit-contract.js';
import { nowMs } from './now.js';
import { chainNativePromise } from './usecase.js';

/** What the app instance lends one unit's observer: who it is, whether anyone listens, where events go. */
export type HandlerObserverSource = {
  readonly appName: string;
  /** The unit's `$unit`. */
  readonly feature: string;
  readonly hasObservers: () => boolean;
  readonly emit: (event: DotHandlerLifecycleEvent) => void;
};

export function handlerObserverFor(source: HandlerObserverSource): DotHandlerObserver {
  const { appName, feature, hasObservers, emit } = source;
  return {
    watching: hasObservers,
    run(ref, run, outcome) {
      // The performance promise: with no observer, nothing is allocated and nothing is wrapped.
      if (!hasObservers()) return run();
      const identity = { kind: 'handler', transport: ref.transport, feature, name: ref.name, appName } as const;
      const startedAt = nowMs();
      emit({ ...identity, status: 'starting', timestamp: Date.now() });
      const complete = (failure: Failure | undefined): void =>
        emit({
          ...identity,
          status: 'completed',
          durationMs: nowMs() - startedAt,
          outcome: failure === undefined ? 'ok' : 'refused',
          ...(failure === undefined ? {} : { failure }),
          timestamp: Date.now(),
        });
      const returned = outcome?.returned;
      const settleValue = (value: unknown): void =>
        complete(returned === undefined ? (isFailure<unknown>(value) ? value : undefined) : returned(value));
      const settleThrown = (error: unknown): void => {
        const refusal = outcome?.thrown?.(error);
        if (refusal !== undefined) {
          emit({
            ...identity,
            status: 'completed',
            durationMs: nowMs() - startedAt,
            outcome: 'refused',
            ...(refusal.failure === undefined ? {} : { failure: refusal.failure }),
            timestamp: Date.now(),
          });
          return;
        }
        emit({ ...identity, status: 'failed', durationMs: nowMs() - startedAt, error, timestamp: Date.now() });
      };
      let result: ReturnType<typeof run>;
      try {
        result = run();
      } catch (error) {
        settleThrown(error);
        throw error;
      }
      // A side branch: the caller keeps the very promise `run` returned, and this branch is registered
      // first, so the event lands before the caller's own continuation. The rejection handler ends the
      // branch (the caller still sees the rejection on the original).
      const branch = chainNativePromise(result, settleValue, settleThrown);
      if (branch === undefined) settleValue(result);
      return result;
    },
  };
}
