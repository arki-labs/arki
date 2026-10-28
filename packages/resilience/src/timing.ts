import { is } from '@arki/schema';
import { z } from 'zod';

const observedTimeSchema = z.number().finite().nonnegative();

function sample(read: () => unknown): number | undefined {
  try {
    const value = read();
    if (is(value, observedTimeSchema)) return value;
    void Promise.resolve(value).catch(() => { /* Observe an invalid asynchronous clock. */ });
  } catch { /* Missing or broken timing cannot change an operation. */ }
  return undefined;
}

/** @internal Retain one clock and its receiver so samples cannot mix time origins. */
export function startTiming() {
  try {
    const read = typeof performance === 'undefined' ? Date.now.bind(Date) : performance.now.bind(performance);
    const started = sample(read);
    return started === undefined ? undefined : { read, started };
  } catch { return; }
}

/** @internal Never manufacture a duration when a sample is missing or moves backwards. */
export function elapsedTime(timing: ReturnType<typeof startTiming>): number | undefined {
  if (timing === undefined) return undefined;
  const ended = sample(timing.read);
  return ended === undefined || ended < timing.started ? undefined : ended - timing.started;
}
