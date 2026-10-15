/// <reference types="node" />
/**
 * Test scaffolding, Node only (vitest runs on Node). Excluded from the build.
 *
 * Time bounds for tests (RFC §13: hostile inputs end within 100 ms, 1 s for
 * `factor`) are measured in CPU time, which does not grow while other
 * programs hold the CPU, so a loaded machine cannot fail them. A cold JIT can
 * still slow one run; the work is deterministic, so the fastest of a few runs
 * measures it.
 */
import { cpuUsage } from 'node:process';

/** One run: its CPU time in ms, and the value it returned or the error it threw. */
export type Timed<T> =
  | { readonly ms: number; readonly ok: true; readonly value: T }
  | { readonly ms: number; readonly ok: false; readonly error: unknown };

function once<T>(run: () => T): Timed<T> {
  const start = cpuUsage();
  const elapsed = (): number => {
    const { user, system } = cpuUsage(start);
    return (user + system) / 1000;
  };
  try {
    const value = run();
    return { ms: elapsed(), ok: true, value };
  } catch (error) {
    return { ms: elapsed(), ok: false, error };
  }
}

/** The fastest of up to `attempts` runs of `run`, stopping at the first run under `bound` ms. */
export function fastest<T>(run: () => T, bound: number, attempts = 3): Timed<T> {
  let best = once(run);
  for (let attempt = 1; attempt < attempts && best.ms >= bound; attempt++) {
    const next = once(run);
    if (next.ms < best.ms) best = next;
  }
  return best;
}
