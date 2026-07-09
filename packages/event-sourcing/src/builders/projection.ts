import type { z } from '@arki/contracts';

import type { AnyEvent } from '../event.js';
import { debugBuilder } from '../debug.js';

/**
 * Type definition for CanHandle predicate
 * Used to filter events that a projection can handle
 */
type CanHandle<EventType extends AnyEvent> = EventType['type'][];

/**
 * Fluent builder for read-model projections.
 *
 * Projections consume event streams and populate query-side views. This builder captures
 * the essentials—projection name, handled event types, validated context—and terminates
 * in a `.handler(...)` call that returns the shape required by Emmett’s projection
 * registration utilities.
 *
 * @example
 * ```ts
 * const userProjection = defineProjection<UserEvent>()
 *   .name('user-projection')
 *   .eventTypes(['UserCreated', 'UserUpdated'])
 *   .contextSchema(z.object({ repo: z.any() }))
 *   .handler(async (events, context) => {
 *     for (const event of events) {
 *       if (event.type === 'UserCreated') {
 *         await context.repo.users.create(event.data);
 *       }
 *     }
 *   });
 * ```
 */
class ProjectionBuilder<EventType extends AnyEvent = never, Context = never> {
  private _name?: string;
  private _eventTypes?: EventType['type'][];
  private _contextSchema?: z.ZodType<Context>;
  private _handlerFn?: (events: EventType[], context: Context) => Promise<void>;

  /**
   * Creates a deep copy of the builder to ensure immutability
   * @private
   */
  private clone(): ProjectionBuilder<EventType, Context> {
    const builder = new ProjectionBuilder<EventType, Context>();
    builder._name = this._name;
    builder._eventTypes = this._eventTypes;
    builder._contextSchema = this._contextSchema;
    builder._handlerFn = this._handlerFn;
    return builder;
  }

  /**
   * Sets the projection name
   * @param name - Unique identifier for the projection
   * @returns A new ProjectionBuilder instance with the name set
   */
  name(name: string): ProjectionBuilder<EventType, Context> {
    const builder = this.clone();
    builder._name = name;
    debugBuilder('[projection] Set name: %s', name);
    return builder;
  }

  /**
   * Sets the event types this projection can handle
   * @param types - Array of event type strings
   * @returns A new ProjectionBuilder instance with the event types set
   */
  eventTypes(types: EventType['type'][]): ProjectionBuilder<EventType, Context> {
    const builder = this.clone();
    builder._eventTypes = types;
    debugBuilder('[projection:%s] Set event types: %o', this._name ?? 'unnamed', types);
    return builder;
  }

  /**
   * Sets the context schema for validation
   * @param schema - Zod schema for validating the context
   * @returns A new ProjectionBuilder instance with the context schema set
   */
  contextSchema<TNewContext>(schema: z.ZodType<TNewContext>): ProjectionBuilder<EventType, TNewContext> {
    const builder = new ProjectionBuilder<EventType, TNewContext>();
    builder._name = this._name;
    builder._eventTypes = this._eventTypes;
    builder._contextSchema = schema;
    builder._handlerFn = this._handlerFn as ((events: EventType[], context: TNewContext) => Promise<void>) | undefined;
    debugBuilder('[projection:%s] Set context schema', this._name ?? 'unnamed');
    return builder;
  }

  /**
   * Terminal method that creates the projection
   *
   * Validates that all required properties are set and returns an object
   * with three properties:
   * - name: The projection name
   * - canHandle: Array of event types to filter events
   * - handle: Function that validates context and processes events
   *
   * @param fn - Function that processes events and updates read models
   * @returns An object containing the projection configuration
   * @throws Error if name, eventTypes, or contextSchema are not defined
   */
  handler(fn: (events: EventType[], context: Context) => Promise<void>): {
    name: string;
    canHandle: CanHandle<EventType>;
    handle: (events: EventType[], context: unknown) => Promise<void>;
  } {
    if (!this._name || !this._eventTypes || !this._contextSchema) {
      debugBuilder('[projection] ERROR: Missing required properties');
      throw new Error('Projection must have name, eventTypes, and contextSchema defined');
    }

    const name = this._name;
    const eventTypes = this._eventTypes;
    const contextSchema = this._contextSchema;

    debugBuilder('[projection:%s] Building handler for event types: %o', name, eventTypes);

    return {
      name,
      canHandle: eventTypes,
      handle: async (events: EventType[], context: unknown) => {
        debugBuilder('[projection:%s] Validating context', name);
        const validatedContext = contextSchema.parse(context);
        debugBuilder('[projection:%s] Processing %d events', name, events.length);
        await fn(events, validatedContext);
        debugBuilder('[projection:%s] Events processed successfully', name);
      },
    };
  }
}

/**
 * Factory function to create a new ProjectionBuilder
 *
 * @example
 * ```typescript
 * const builder = defineProjection<MyEvent>()
 *   .name('my-projection')
 *   .eventTypes(['EventTypeA', 'EventTypeB'])
 *   .contextSchema(myContextSchema)
 *   .handler(async (events, context) => { ... });
 * ```
 */
export function defineProjection<EventType extends AnyEvent = never>(): ProjectionBuilder<EventType, never> {
  debugBuilder('[projection] Creating new projection builder');
  return new ProjectionBuilder<EventType, never>();
}
