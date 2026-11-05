import { getLogger } from '@arki/log';

import type { PubSubBackend } from './telemetry.js';
import type { OnMessage } from './types.js';
import { observeDelivery } from './telemetry.js';

const log = getLogger('arki:pubsub');

function warnThrown(channel: string, error: unknown): void {
  log.warn('a subscriber on {channel} threw: {message}', {
    channel,
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Hands one message to one subscriber, in a `pubsub.deliver` span. A subscriber that throws, or
 * returns a promise that rejects (an `async` callback is accepted where `OnMessage` returns
 * `void`), is logged at warn and never reaches the other subscribers or becomes an unhandled
 * rejection.
 */
export function deliver(backend: PubSubBackend, channel: string, onMessage: OnMessage, payload: string): void {
  observeDelivery(
    backend,
    () => onMessage(payload),
    error => warnThrown(channel, error),
  );
}
