import type { z } from '@arki/contracts';

import type { Event } from '../event.js';
import { debugBuilder } from '../debug.js';

/**
 * Type definition for CanHandle predicate
 * Used to filter events that a stateful process manager can handle
 */
type CanHandle<EventType extends Event> = EventType['type'][];

/**
 * StatefulProcessManagerBuilder - Fluent API for building type-safe stateful process managers (sagas)
 *
 * Provides an immutable builder pattern for creating stateful process managers with:
 * - Type safety through TypeScript generics
 * - Runtime validation through Zod schemas
 * - ORPC-style API with .handler() as terminal method
 * - Persistent state management with load/save operations
 *
 * A Stateful Process Manager (Saga) maintains state across events to coordinate complex,
 * long-running business processes by:
 * - name: Unique identifier for the stateful process manager
 * - eventTypes: Array of event types this process manager handles
 * - stateSchema: Schema for validating process manager state
 * - contextSchema: Schema for validating execution context
 * - getStateId: Function to extract state identifier from events
 * - loadState: Function to load existing state from storage
 * - saveState: Function to persist state to storage
 * - handler: Function that processes individual events and returns updated state
 *
 * @example
 * ```typescript
 * type OrderState = {
 *   orderId: string;
 *   status: 'pending' | 'paid' | 'shipped' | 'completed';
 *   paymentId?: string;
 *   trackingId?: string;
 * };
 *
 * const orderProcessManager = defineStatefulProcessManager<OrderEvent, OrderState>()
 *   .name('order-fulfillment')
 *   .eventTypes(['OrderPlaced', 'PaymentProcessed', 'OrderShipped'])
 *   .stateSchema(z.object({
 *     orderId: z.string(),
 *     status: z.enum(['pending', 'paid', 'shipped', 'completed']),
 *     paymentId: z.string().optional(),
 *     trackingId: z.string().optional(),
 *   }))
 *   .contextSchema(z.object({ messageBus: z.any(), repo: z.any() }))
 *   .getStateId(event => `order-${event.data.orderId}`)
 *   .loadState(async (stateId, context) => {
 *     return await context.repo.orderSagas.findById(stateId);
 *   })
 *   .saveState(async (stateId, state, context) => {
 *     await context.repo.orderSagas.upsert({ id: stateId, ...state });
 *   })
 *   .handler(async (event, state, context) => {
 *     if (event.type === 'OrderPlaced') {
 *       // Initialize state for new order
 *       return {
 *         orderId: event.data.orderId,
 *         status: 'pending',
 *       };
 *     } else if (event.type === 'PaymentProcessed') {
 *       // Update state after payment
 *       return {
 *         ...state!,
 *         status: 'paid',
 *         paymentId: event.data.paymentId,
 *       };
 *     } else if (event.type === 'OrderShipped') {
 *       // Update state after shipping
 *       return {
 *         ...state!,
 *         status: 'shipped',
 *         trackingId: event.data.trackingId,
 *       };
 *     }
 *     return state!;
 *   });
 * ```
 */
class StatefulProcessManagerBuilder<EventType extends Event = never, State = never, Context = never> {
  private _name?: string;
  private _eventTypes?: EventType['type'][];
  private _stateSchema?: z.ZodType<State>;
  private _contextSchema?: z.ZodType<Context>;
  private _getStateIdFn?: (event: EventType) => string;
  private _loadStateFn?: (stateId: string, context: Context) => Promise<State | null>;
  private _saveStateFn?: (stateId: string, state: State, context: Context) => Promise<void>;
  private _handlerFn?: (event: EventType, state: State | null, context: Context) => Promise<State>;

  /**
   * Creates a deep copy of the builder to ensure immutability
   * @private
   */
  private clone(): StatefulProcessManagerBuilder<EventType, State, Context> {
    const builder = new StatefulProcessManagerBuilder<EventType, State, Context>();
    builder._name = this._name;
    builder._eventTypes = this._eventTypes;
    builder._stateSchema = this._stateSchema;
    builder._contextSchema = this._contextSchema;
    builder._getStateIdFn = this._getStateIdFn;
    builder._loadStateFn = this._loadStateFn;
    builder._saveStateFn = this._saveStateFn;
    builder._handlerFn = this._handlerFn;
    return builder;
  }

  /**
   * Sets the stateful process manager name
   * @param name - Unique identifier for the stateful process manager
   * @returns A new StatefulProcessManagerBuilder instance with the name set
   */
  name(name: string): StatefulProcessManagerBuilder<EventType, State, Context> {
    const builder = this.clone();
    builder._name = name;
    debugBuilder('[stateful-process-manager] Set name: %s', name);
    return builder;
  }

  /**
   * Sets the event types this stateful process manager can handle
   * @param types - Array of event type strings
   * @returns A new StatefulProcessManagerBuilder instance with the event types set
   */
  eventTypes(types: EventType['type'][]): StatefulProcessManagerBuilder<EventType, State, Context> {
    const builder = this.clone();
    builder._eventTypes = types;
    debugBuilder('[stateful-process-manager:%s] Set event types: %o', this._name ?? 'unnamed', types);
    return builder;
  }

  /**
   * Sets the state schema for validation
   * @param schema - Zod schema for validating the stateful process manager state
   * @returns A new StatefulProcessManagerBuilder instance with the state schema set
   */
  stateSchema<TNewState>(schema: z.ZodType<TNewState>): StatefulProcessManagerBuilder<EventType, TNewState, Context> {
    const builder = new StatefulProcessManagerBuilder<EventType, TNewState, Context>();
    builder._name = this._name;
    builder._eventTypes = this._eventTypes;
    builder._stateSchema = schema;
    builder._contextSchema = this._contextSchema;
    builder._getStateIdFn = this._getStateIdFn as ((event: EventType) => string) | undefined;
    builder._loadStateFn = this._loadStateFn as
      | ((stateId: string, context: Context) => Promise<TNewState | null>)
      | undefined;
    builder._saveStateFn = this._saveStateFn as
      | ((stateId: string, state: TNewState, context: Context) => Promise<void>)
      | undefined;
    builder._handlerFn = this._handlerFn as
      | ((event: EventType, state: TNewState | null, context: Context) => Promise<TNewState>)
      | undefined;
    debugBuilder('[stateful-process-manager:%s] Set state schema', this._name ?? 'unnamed');
    return builder;
  }

  /**
   * Sets the context schema for validation
   * @param schema - Zod schema for validating the execution context
   * @returns A new StatefulProcessManagerBuilder instance with the context schema set
   */
  contextSchema<TNewContext>(
    schema: z.ZodType<TNewContext>,
  ): StatefulProcessManagerBuilder<EventType, State, TNewContext> {
    const builder = new StatefulProcessManagerBuilder<EventType, State, TNewContext>();
    builder._name = this._name;
    builder._eventTypes = this._eventTypes;
    builder._stateSchema = this._stateSchema;
    builder._contextSchema = schema;
    builder._getStateIdFn = this._getStateIdFn;
    builder._loadStateFn = this._loadStateFn as
      | ((stateId: string, context: TNewContext) => Promise<State | null>)
      | undefined;
    builder._saveStateFn = this._saveStateFn as
      | ((stateId: string, state: State, context: TNewContext) => Promise<void>)
      | undefined;
    builder._handlerFn = this._handlerFn as
      | ((event: EventType, state: State | null, context: TNewContext) => Promise<State>)
      | undefined;
    debugBuilder('[stateful-process-manager:%s] Set context schema', this._name ?? 'unnamed');
    return builder;
  }

  /**
   * Sets the function to extract state identifier from events
   * @param fn - Function that extracts a unique state identifier from an event
   * @returns A new StatefulProcessManagerBuilder instance with the getStateId function set
   */
  getStateId(fn: (event: EventType) => string): StatefulProcessManagerBuilder<EventType, State, Context> {
    const builder = this.clone();
    builder._getStateIdFn = fn;
    debugBuilder('[stateful-process-manager:%s] Set getStateId function', this._name ?? 'unnamed');
    return builder;
  }

  /**
   * Sets the function to load existing state from storage
   * @param fn - Function that loads state by identifier, returns null if state doesn't exist
   * @returns A new StatefulProcessManagerBuilder instance with the loadState function set
   */
  loadState(
    fn: (stateId: string, context: Context) => Promise<State | null>,
  ): StatefulProcessManagerBuilder<EventType, State, Context> {
    const builder = this.clone();
    builder._loadStateFn = fn;
    debugBuilder('[stateful-process-manager:%s] Set loadState function', this._name ?? 'unnamed');
    return builder;
  }

  /**
   * Sets the function to persist state to storage
   * @param fn - Function that saves state by identifier
   * @returns A new StatefulProcessManagerBuilder instance with the saveState function set
   */
  saveState(
    fn: (stateId: string, state: State, context: Context) => Promise<void>,
  ): StatefulProcessManagerBuilder<EventType, State, Context> {
    const builder = this.clone();
    builder._saveStateFn = fn;
    debugBuilder('[stateful-process-manager:%s] Set saveState function', this._name ?? 'unnamed');
    return builder;
  }

  /**
   * Terminal method that creates the stateful process manager
   *
   * Validates that all required configuration is set and returns an object
   * with three properties:
   * - processorId: The stateful process manager identifier
   * - canHandle: Array of event types to filter events
   * - eachBatch: Function that validates context, loads state for each event,
   *              processes it through the handler, and saves the updated state
   *
   * @param fn - Function that processes individual events with their state and returns updated state
   * @returns An object containing the stateful process manager configuration
   * @throws Error if name, eventTypes, stateSchema, contextSchema, getStateId, loadState, or saveState are not defined
   */
  handler(fn: (event: EventType, state: State | null, context: Context) => Promise<State>): {
    processorId: string;
    canHandle: CanHandle<EventType>;
    eachBatch: (events: EventType[], context: unknown) => Promise<void>;
  } {
    if (
      !this._name ||
      !this._eventTypes ||
      !this._stateSchema ||
      !this._contextSchema ||
      !this._getStateIdFn ||
      !this._loadStateFn ||
      !this._saveStateFn
    ) {
      debugBuilder('[stateful-process-manager] ERROR: Missing required properties');
      throw new Error('Stateful process manager must have all configuration methods called');
    }

    const name = this._name;
    const eventTypes = this._eventTypes;
    const stateSchema = this._stateSchema;
    const contextSchema = this._contextSchema;
    const getStateIdFn = this._getStateIdFn;
    const loadStateFn = this._loadStateFn;
    const saveStateFn = this._saveStateFn;

    debugBuilder('[stateful-process-manager:%s] Building handler for event types: %o', name, eventTypes);

    return {
      processorId: name,
      canHandle: eventTypes,
      eachBatch: async (events: EventType[], context: unknown) => {
        debugBuilder('[stateful-process-manager:%s] Validating context', name);
        const validatedContext = contextSchema.parse(context);
        debugBuilder('[stateful-process-manager:%s] Processing batch of %d events', name, events.length);

        for (const event of events) {
          const stateId = getStateIdFn(event);
          debugBuilder('[stateful-process-manager:%s] Processing event with stateId: %s', name, stateId);

          // Load state
          debugBuilder('[stateful-process-manager:%s] Loading state for: %s', name, stateId);
          const state = await loadStateFn(stateId, validatedContext);
          const validatedState = state ? stateSchema.parse(state) : null;
          debugBuilder(
            '[stateful-process-manager:%s] State loaded: %s',
            name,
            validatedState ? 'existing state' : 'no existing state',
          );

          // Handle event
          debugBuilder('[stateful-process-manager:%s] Handling event', name);
          const newState = await fn(event, validatedState, validatedContext);
          const validatedNewState = stateSchema.parse(newState);
          debugBuilder('[stateful-process-manager:%s] Event handled, new state computed', name);

          // Save state
          debugBuilder('[stateful-process-manager:%s] Saving state for: %s', name, stateId);
          await saveStateFn(stateId, validatedNewState, validatedContext);
          debugBuilder('[stateful-process-manager:%s] State saved successfully', name);
        }

        debugBuilder('[stateful-process-manager:%s] Batch processed successfully', name);
      },
    };
  }
}

/**
 * Factory function to create a new StatefulProcessManagerBuilder
 *
 * @example
 * ```typescript
 * const builder = defineStatefulProcessManager<MyEvent, MyState>()
 *   .name('my-stateful-process-manager')
 *   .eventTypes(['EventTypeA', 'EventTypeB'])
 *   .stateSchema(myStateSchema)
 *   .contextSchema(myContextSchema)
 *   .getStateId(event => `state-${event.data.id}`)
 *   .loadState(async (stateId, context) => {
 *     return await context.repo.findById(stateId);
 *   })
 *   .saveState(async (stateId, state, context) => {
 *     await context.repo.upsert({ id: stateId, ...state });
 *   })
 *   .handler(async (event, state, context) => {
 *     // Process event and return updated state
 *     return { ...state, updated: true };
 *   });
 * ```
 */
export function defineStatefulProcessManager<
  EventType extends Event = never,
  State = never,
>(): StatefulProcessManagerBuilder<EventType, State, never> {
  debugBuilder('[stateful-process-manager] Creating new stateful process manager builder');
  return new StatefulProcessManagerBuilder<EventType, State, never>();
}
