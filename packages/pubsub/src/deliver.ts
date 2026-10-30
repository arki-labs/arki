import { getLogger } from '@arki/log';

import type { OnMessage } from './types.js';

const log = getLogger('arki:pubsub');

function warnThrown(channel: string, error: unknown): void {
  log.warn('a subscriber on {channel} threw: {message}', {
    channel,
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Hands one message to one subscriber. A subscriber that throws, or returns a promise that rejects
 * (an `async` callback is accepted where `OnMessage` returns `void`), is logged at warn and never
 * reaches the other subscribers or becomes an unhandled rejection.
 */
export function deliver(channel: string, onMessage: OnMessage, payload: string): void {
  try {
    const result: unknown = onMessage(payload);
    if (result instanceof Promise) result.catch((error: unknown) => warnThrown(channel, error));
  } catch (error) {
    warnThrown(channel, error);
  }
}
