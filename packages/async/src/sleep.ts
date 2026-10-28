import type { Clock } from '@arki/clock';
import type { FailureOf } from '@arki/failure';
import { SleepCancelled } from '@arki/clock';
import { UnexpectedDefect } from '@arki/failure';

import { assertWait, Cancelled } from './errors.js';
import { systemClock } from './system-clock.js';

/** Options of {@link sleep}. */
export type SleepOptions = {
  /** Cuts the wait short, returning Cancelled with the private signal reason. */
  readonly signal?: AbortSignal;
  /** Whose timer to wait on. Default: the system clock. */
  readonly clock?: Clock;
};

/** Waits for a timer, returning cancellation or a supervised provider defect. Invalid delays are static misuse. */
export function sleep(
  ms: number,
  options?: { readonly clock?: never; readonly signal?: never },
): Promise<void | Exclude<FailureOf<typeof sleepRuntime>, ReturnType<typeof Cancelled>>>;
export function sleep(ms: number, options: SleepOptions): Promise<void | FailureOf<typeof sleepRuntime>>;
export function sleep(ms: number, options: SleepOptions = {}): Promise<void | FailureOf<typeof sleepRuntime>> {
  return sleepRuntime(ms, options);
}
async function sleepRuntime(ms: number, options: SleepOptions) {
  assertWait('sleep', 'ms', ms);
  try {
    const result = await (options.clock ?? systemClock).sleep(ms, options.signal);
    if (SleepCancelled.is(result)) return Cancelled({ cause: result.cause });
    if (UnexpectedDefect.is(result)) return result;
    if (result !== undefined) return UnexpectedDefect({ cause: result });
    return;
  } catch (error) {
    return UnexpectedDefect.is(error) ? error : UnexpectedDefect({ cause: error });
  }
}
