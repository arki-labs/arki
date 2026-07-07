import type { z } from '@arki/contracts';

import type { Event } from '../event.js';
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
>(config: EventConfig<TType, TData, TMetadata>): (data: TData, metadata?: TMetadata) => Event<TType, TData, TMetadata> {
  const { type, dataSchema, metadataSchema } = config;

  return (data: TData, metadata?: TMetadata) => {
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
}
