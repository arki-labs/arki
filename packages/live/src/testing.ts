/**
 * `@arki/live/testing`: test helpers. Portable.
 */
import type { LiveSource, LiveSourceEvent } from './hub.js';
import { LIVE_ERROR_CODES, liveError } from './errors.js';

/** A source the test drives: `emit` delivers to the hub that started it. */
export function fakeSource(): LiveSource & { emit(event: LiveSourceEvent): void } {
  let receive: ((event: LiveSourceEvent) => void) | undefined;
  return {
    start(next) {
      receive = next;
      const stop = (): Promise<void> => {
        receive = undefined;
        return Promise.resolve();
      };
      return Promise.resolve(stop);
    },
    emit(event) {
      if (!receive) {
        throw liveError(
          LIVE_ERROR_CODES.source,
          'fakeSource().emit() before a hub started it (or after it stopped)',
          'Call hub.start() first.',
        );
      }
      receive(event);
    },
  };
}
