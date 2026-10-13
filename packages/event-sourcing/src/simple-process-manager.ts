import type { Event } from '@event-driven-io/emmett';
import { reactor } from '@event-driven-io/emmett';

import { debugProcess } from './debug.js';

/**
 * Creates a simple process manager that reacts to events one at a time,
 * with a pre-bound context closed over at construction time.
 *
 * This is a thin wrapper around Emmett's `reactor` that exposes a positional
 * API with per-message processing semantics. It is intended for the most
 * common process manager use case where:
 *
 * - The context (repositories, KV, message bus, etc.) is fixed at construction time.
 * - The handler operates on one event at a time rather than a batch.
 * - Errors propagate to the consumer so the underlying subscription can
 *   apply retry/back-off policies.
 *
 * For richer use cases (per-batch processing, lifecycle hooks, stateful
 * sagas, idempotency) prefer {@link createProcessManager} or
 * {@link createStatefulProcessManager} from this package.
 *
 * @example
 * ```ts
 * const trackingNotifications = createSimpleProcessManager(
 *   { repo, kv },
 *   'tracking-notifications',
 *   ['MovieWatchLogged', 'TvShowRated'],
 *   async (event, context) => {
 *     // ... handle one event using context
 *   },
 * );
 * ```
 *
 * @param context Fixed context closed over by the process manager handler.
 * @param name Unique identifier for the process manager (used as processor id).
 * @param eventTypes Event types this process manager reacts to.
 * @param handlerFn Async function invoked once per matching event.
 */
export function createSimpleProcessManager<TEvent extends Event, TContext extends object>(
  context: TContext,
  name: string,
  eventTypes: TEvent['type'][],
  handlerFn: (event: TEvent, context: TContext) => Promise<void>,
) {
  debugProcess(
    '[createSimpleProcessManager] Creating process manager: %s for event types: %s',
    name,
    eventTypes.join(', '),
  );
  return reactor<TEvent>({
    canHandle: [...eventTypes],
    eachMessage: async message => {
      debugProcess('[createSimpleProcessManager:%s] Processing event: %s', name, message.type);
      try {
        await handlerFn(message, context);
        debugProcess('[createSimpleProcessManager:%s] Successfully processed event: %s', name, message.type);
      } catch (error) {
        debugProcess(
          '[createSimpleProcessManager:%s] Error processing event %s: %s',
          name,
          message.type,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    },
    processorId: `process-manager-${name}`,
  });
}
