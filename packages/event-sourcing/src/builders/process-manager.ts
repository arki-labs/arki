import type { z } from '@arki/contracts';

import type { Event } from '../event.js';
import { debugBuilder } from '../debug.js';

/**
 * Type definition for CanHandle predicate
 * Used to filter events that a process manager can handle
 */
type CanHandle<EventType extends Event> = EventType['type'][];

/**
 * Fluent builder for Emmett process managers (sagas).
 *
 * Process managers sit outside an aggregate and react to streams of events in order to
 * coordinate long-running workflows. This builder helps you describe that behaviour with
 * explicit event filters, a validated execution context, and a terminal `.handler(...)`
 * that produces the configuration object Emmett expects.
 *
 * @example
 * ```ts
 * const orderSaga = defineProcessManager<OrderEvent>()
 *   .name('order-fulfillment')
 *   .eventTypes(['OrderPlaced', 'PaymentProcessed', 'OrderShipped'])
 *   .contextSchema(z.object({ messageBus: z.any(), repo: z.any() }))
 *   .handler(async (events, context) => {
 *     for (const event of events) {
 *       if (event.type === 'OrderPlaced') {
 *         await context.messageBus.send({ type: 'ProcessPayment', data: event.data });
 *       } else if (event.type === 'PaymentProcessed') {
 *         await context.messageBus.send({ type: 'ShipOrder', data: event.data });
 *       }
 *     }
 *   });
 * ```
 */
class ProcessManagerBuilder<EventType extends Event = never, Context = never> {
  private _name?: string;
  private _eventTypes?: EventType['type'][];
  private _contextSchema?: z.ZodType<Context>;
  private _handlerFn?: (events: EventType[], context: Context) => Promise<void>;

  /**
   * Creates a deep copy of the builder to ensure immutability
   * @private
   */
  private clone(): ProcessManagerBuilder<EventType, Context> {
    const builder = new ProcessManagerBuilder<EventType, Context>();
    builder._name = this._name;
    builder._eventTypes = this._eventTypes;
    builder._contextSchema = this._contextSchema;
    builder._handlerFn = this._handlerFn;
    return builder;
  }

  /**
   * Sets the process manager name
   * @param name - Unique identifier for the process manager
   * @returns A new ProcessManagerBuilder instance with the name set
   */
  name(name: string): ProcessManagerBuilder<EventType, Context> {
    const builder = this.clone();
    builder._name = name;
    debugBuilder('[process-manager] Set name: %s', name);
    return builder;
  }

  /**
   * Sets the event types this process manager can handle
   * @param types - Array of event type strings
   * @returns A new ProcessManagerBuilder instance with the event types set
   */
  eventTypes(types: EventType['type'][]): ProcessManagerBuilder<EventType, Context> {
    const builder = this.clone();
    builder._eventTypes = types;
    debugBuilder('[process-manager:%s] Set event types: %o', this._name ?? 'unnamed', types);
    return builder;
  }

  /**
   * Sets the context schema for validation
   * @param schema - Zod schema for validating the context
   * @returns A new ProcessManagerBuilder instance with the context schema set
   */
  contextSchema<TNewContext>(schema: z.ZodType<TNewContext>): ProcessManagerBuilder<EventType, TNewContext> {
    const builder = new ProcessManagerBuilder<EventType, TNewContext>();
    builder._name = this._name;
    builder._eventTypes = this._eventTypes;
    builder._contextSchema = schema;
    builder._handlerFn = this._handlerFn as ((events: EventType[], context: TNewContext) => Promise<void>) | undefined;
    debugBuilder('[process-manager:%s] Set context schema', this._name ?? 'unnamed');
    return builder;
  }

  /**
   * Terminal method that creates the process manager
   *
   * Validates that all required properties are set and returns an object
   * with three properties:
   * - processorId: The process manager identifier
   * - canHandle: Array of event types to filter events
   * - eachBatch: Function that validates context and processes event batches
   *
   * @param fn - Function that processes event batches to coordinate workflows
   * @returns An object containing the process manager configuration
   * @throws Error if name, eventTypes, or contextSchema are not defined
   */
  handler(fn: (events: EventType[], context: Context) => Promise<void>): {
    processorId: string;
    canHandle: CanHandle<EventType>;
    eachBatch: (events: EventType[], context: unknown) => Promise<void>;
  } {
    if (!this._name || !this._eventTypes || !this._contextSchema) {
      debugBuilder('[process-manager] ERROR: Missing required properties');
      throw new Error('Process manager must have name, eventTypes, and contextSchema defined');
    }

    const name = this._name;
    const eventTypes = this._eventTypes;
    const contextSchema = this._contextSchema;

    debugBuilder('[process-manager:%s] Building handler for event types: %o', name, eventTypes);

    return {
      processorId: name,
      canHandle: eventTypes,
      eachBatch: async (events: EventType[], context: unknown) => {
        debugBuilder('[process-manager:%s] Validating context', name);
        const validatedContext = contextSchema.parse(context);
        debugBuilder('[process-manager:%s] Processing batch of %d events', name, events.length);
        await fn(events, validatedContext);
        debugBuilder('[process-manager:%s] Batch processed successfully', name);
      },
    };
  }
}

/**
 * Factory function to create a new ProcessManagerBuilder
 *
 * @example
 * ```typescript
 * const builder = defineProcessManager<MyEvent>()
 *   .name('my-process-manager')
 *   .eventTypes(['EventTypeA', 'EventTypeB'])
 *   .contextSchema(myContextSchema)
 *   .handler(async (events, context) => { ... });
 * ```
 */
export function defineProcessManager<EventType extends Event = never>(): ProcessManagerBuilder<EventType, never> {
  debugBuilder('[process-manager] Creating new process manager builder');
  return new ProcessManagerBuilder<EventType, never>();
}
