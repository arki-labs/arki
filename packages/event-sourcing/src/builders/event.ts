import type { z } from '@arki/contracts';

import type { Event } from '../event.js';
import type { EventSourcingActionDeclaration, JsonObject } from '../dot-action.js';
import { EVENT_SOURCING_ACTION_META_SCHEMA, schemaToJsonObject } from '../dot-action.js';
import type { DefaultRecord } from '../types.js';

/**
 * Configuration for defining a domain event factory.
 */
export type EventConfig<
  TType extends string,
  TData extends DefaultRecord,
  TMetadata extends DefaultRecord | undefined = undefined,
> = {
  /** The event type string (e.g., 'UserCreated') */
  type: TType;
  /** Zod schema for validating event data */
  dataSchema: z.ZodType<TData>;
  /** Optional Zod schema for validating event metadata */
  metadataSchema?: z.ZodType<TMetadata>;
};

export type EventFactory<
  TType extends string,
  TData extends DefaultRecord,
  TMetadata extends DefaultRecord | undefined = undefined,
> = ((data: TData, metadata?: TMetadata) => Event<TType, TData, TMetadata>) &
  EventSourcingActionDeclaration & {
    readonly type: TType;
    readonly dataSchema: z.ZodType<TData>;
    readonly metadataSchema?: z.ZodType<TMetadata>;
    toDotAction(): EventSourcingActionDeclaration;
  };

function eventAction<TType extends string>(
  type: TType,
  dataSchema: z.ZodType,
): EventSourcingActionDeclaration {
  return {
    id: type,
    binding: 'es',
    direction: 'out',
    address: type,
    metaSchema: EVENT_SOURCING_ACTION_META_SCHEMA,
    meta: {
      kind: 'event',
      data: schemaToJsonObject(dataSchema, `event "${type}" data`),
    },
  };
}

/**
 * Creates a strongly-typed event factory function.
 *
 * This factory validates data and metadata using Zod schemas before
 * creating events that can be appended to Emmett's event store.
 *
 * @param config - Configuration object containing type, data schema, and optional metadata schema
 * @returns A factory function that validates and creates events
 *
 * @example
 * ```ts
 * const userCreatedEvent = defineEvent({
 *   type: 'UserCreated',
 *   dataSchema: z.object({ userId: z.string().uuid(), name: z.string() }),
 *   metadataSchema: z.object({ now: z.date(), correlationId: z.string().uuid() }),
 * });
 *
 * const event = userCreatedEvent(
 *   { userId: 'usr_123', name: 'Ada' },
 *   { now: new Date(), correlationId: 'corr_456' },
 * );
 * ```
 */
export function defineEvent<
  TType extends string,
  TData extends DefaultRecord,
  TMetadata extends DefaultRecord | undefined = undefined,
>(config: EventConfig<TType, TData, TMetadata>): EventFactory<TType, TData, TMetadata> {
  const { type, dataSchema, metadataSchema } = config;
  let cachedAction: EventSourcingActionDeclaration | undefined;

  const factory = (data: TData, metadata?: TMetadata) => {
    const validatedData = dataSchema.parse(data);
    const validatedMetadata = metadataSchema ? metadataSchema.parse(metadata) : metadata;

    // Conditionally construct the event object based on whether metadata is provided
    return (validatedMetadata === undefined
      ? {
          type,
          data: validatedData,
        }
      : {
          type,
          data: validatedData,
          metadata: validatedMetadata,
        }) as unknown as Event<TType, TData, TMetadata>;
  };

  const getAction = (): EventSourcingActionDeclaration => {
    cachedAction ??= eventAction(type, dataSchema);
    return cachedAction;
  };

  Object.defineProperties(factory, {
    type: { value: type, enumerable: true },
    dataSchema: { value: dataSchema },
    ...(metadataSchema === undefined ? {} : { metadataSchema: { value: metadataSchema } }),
    id: { value: type, enumerable: true },
    binding: { value: 'es', enumerable: true },
    direction: { value: 'out', enumerable: true },
    address: { value: type, enumerable: true },
    metaSchema: { value: EVENT_SOURCING_ACTION_META_SCHEMA, enumerable: true },
    meta: {
      enumerable: true,
      get(): JsonObject {
        return getAction().meta;
      },
    },
    toDotAction: { value: getAction },
  });

  return factory as EventFactory<TType, TData, TMetadata>;
}
