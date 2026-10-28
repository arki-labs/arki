import type { IDefaultPolicyContext } from 'cockatiel';
import { timeout, TimeoutStrategy } from 'cockatiel';
import { is } from '@arki/schema';
import { z } from 'zod';
import type { TimeoutPolicy, FailureEvent, SuccessEvent } from './policy.js';
import type { TimeoutFailure } from './errors.js';
import type { Engine } from './engine.js';
import { Timeout, Cancelled } from './errors.js';
import { fromEngine, ownedEngine } from './engine.js';
import { createEvent } from './event.js';
import { withPolicySpan } from './telemetry.js';

const cancelledErrorSchema = z.object({ isTaskCancelledError: z.literal(true) });

class TimeoutEngine implements Engine<TimeoutFailure> {
  declare readonly _altReturn: TimeoutFailure;
  readonly success = createEvent<SuccessEvent>();
  readonly failure = createEvent<FailureEvent>();
  readonly deadline = createEvent<void>();
  readonly onSuccess = this.success.on;
  readonly onFailure = this.failure.on;
  readonly onTimeout = this.deadline.on;
  constructor(readonly timeoutMs: number) {}
  async execute<T>(fn: (context: IDefaultPolicyContext) => PromiseLike<T> | T, signal?: AbortSignal) {
    return withPolicySpan('resilience.timeout', () => this.run(fn, signal));
  }
  private async run<T>(fn: (context: IDefaultPolicyContext) => PromiseLike<T> | T, signal?: AbortSignal) {
    // A per-call engine has no persistent state. Its first observer captures origin
    // before subscribers can synchronously abort the caller.
    const engine = timeout(this.timeoutMs, TimeoutStrategy.Aggressive);
    let cancellation: TimeoutFailure | undefined;
    engine.onTimeout(() => {
      cancellation = signal?.aborted ? Cancelled({ cause: signal.reason }) : Timeout();
      this.deadline.emit();
    });
    const owned = ownedEngine(engine, error => {
      if (is(error, cancelledErrorSchema) && cancellation !== undefined) return cancellation;
      throw error;
    });
    owned.onSuccess(this.success.emit);
    owned.onFailure(this.failure.emit);
    try {
      return await owned.execute(fn, signal);
    } catch (error) {
      // Cooperative work may reject on abort before the SDK race rejects. The
      // already-captured cancellation owns that refusal, not its AbortError.
      if (cancellation !== undefined) return cancellation;
      throw error;
    }
  }
}
/** @internal Each deadline owns cancellation origin, independently of concurrent calls. */
export function timeoutPolicy(timeoutMs: number): TimeoutPolicy {
  const engine = new TimeoutEngine(timeoutMs);
  return fromEngine(engine, { onTimeout: engine.onTimeout });
}
