/** Timer helpers shared by every dialect's background loops. */
import { is, recordSchema } from '@arki/schema';

/**
 * Let the process exit while this timer waits. Node and Bun return a timer object
 * with `unref`; browsers, Deno's web API and Hermes return a number, which never
 * holds a process open, so there is nothing to do.
 */
export function unrefTimer(timer: unknown): void {
  if (is(timer, recordSchema) && 'unref' in timer && typeof timer.unref === 'function')
    timer.unref();
}
