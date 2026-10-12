import { z } from '@arki/contracts';
import type { CanHandle, Event, ReadEvent } from '@event-driven-io/emmett';
import type {
  PostgresEventStore,
  PostgresEventStoreOptions,
  PostgreSQLProjectionHandlerContext,
  PostgresReadEventMetadata,
} from '@event-driven-io/emmett-postgresql';
import {
  defaultPostgreSQLOptions,
  getPostgreSQLEventStore,
  postgreSQLProjection,
} from '@event-driven-io/emmett-postgresql';
import type { TablesRelationalConfig } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { debugProjection, debugStore } from './debug.js';

export type PostgresReadEvent<EventType extends Event> = ReadEvent<EventType, PostgresReadEventMetadata>;

export {
  defaultPostgreSQLOptions,
  PostgreSQLEventStoreDefaultStreamVersion,
  getPostgreSQLEventStore,
  postgreSQLProjection,
} from '@event-driven-io/emmett-postgresql';

export const postgresEventStoreConfigSchema = z.object({
  connectionString: z.string().min(1, 'PostgreSQL connection string is required'),
});

export type PostgresEventStoreConfig = z.infer<typeof postgresEventStoreConfigSchema>;

export const postgresEventStoreOptionsSchema = z
  .object({
    projections: z.array(z.unknown()).optional(),
    schema: z
      .object({
        autoMigration: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    connectionOptions: z.record(z.string(), z.unknown()).optional(),
    hooks: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type PostgresEventStoreOptionsInput = z.infer<typeof postgresEventStoreOptionsSchema>;

const mergeEventStoreOptions = (
  options: PostgresEventStoreOptionsInput | undefined,
): PostgresEventStoreOptions => {
  if (!options) return { ...defaultPostgreSQLOptions };

  return {
    ...defaultPostgreSQLOptions,
    ...options,
  } as PostgresEventStoreOptions;
};

export type EventStoreWithCleanup = {
  eventStore: PostgresEventStore;
  close: () => Promise<void>;
};

export const getEventStore = (
  connectionString: string,
  options: PostgresEventStoreOptions = defaultPostgreSQLOptions,
): EventStoreWithCleanup => {
  debugStore('Creating event store with connection string and options');
  const eventStore = getPostgreSQLEventStore(connectionString, options);
  debugStore('Event store created successfully');

  return {
    eventStore,
    close: async () => {
      debugStore('Closing event store connection pool');
      try {
        // The emmett-postgresql event store has a close method that closes the underlying Pool
        if (eventStore && typeof (eventStore as any).close === 'function') {
          await (eventStore as any).close();
          debugStore('Event store connection pool closed successfully');
        } else {
          debugStore('Event store does not have a close method, skipping');
        }
      } catch (error) {
        debugStore('Error closing event store: %O', error);
        throw error;
      }
    },
  };
};

export const normalizePostgresEventStoreOptions = (options?: unknown): PostgresEventStoreOptions =>
  mergeEventStoreOptions(
    options === undefined ? undefined : postgresEventStoreOptionsSchema.parse(options),
  );

export const createPostgresEventStore = (
  config: unknown,
  options?: unknown,
): PostgresEventStore => {
  debugStore('Creating Postgres event store from config');
  const { connectionString } = postgresEventStoreConfigSchema.parse(config);
  debugStore('Config validated successfully');

  const parsedOptions = normalizePostgresEventStoreOptions(options);
  debugStore('Options normalized: projections=%d', parsedOptions.projections?.length ?? 0);

  const eventStore = getPostgreSQLEventStore(connectionString, parsedOptions);
  debugStore('Postgres event store created successfully');
  return eventStore;
};

export type DrizzleProjectionHandlerContext<TSchema extends TablesRelationalConfig> =
  PostgreSQLProjectionHandlerContext & {
    db: NodePgDatabase<TSchema>;
  };

export { projections, type CanHandle } from '@event-driven-io/emmett';

export const drizzleProjection = <EventType extends Event, TSchema extends TablesRelationalConfig>(
  db: NodePgDatabase<TSchema>,
  {
    handle,
    canHandle,
  }: {
    handle: (
      events: PostgresReadEvent<EventType>[],
      context: DrizzleProjectionHandlerContext<TSchema>,
    ) => Promise<void>;
    canHandle: CanHandle<EventType>;
  },
) => {
  debugProjection('Creating Drizzle projection with canHandle filter');
  return postgreSQLProjection<EventType>({
    canHandle,
    handle: async (events, context) => {
      debugProjection('Processing %d events in Drizzle projection', events.length);
      await handle(events, {
        ...context,
        db,
      });
      debugProjection('Drizzle projection processed events successfully');
    },
  });
};

export type DrizzleProjectionHandlerContextWithRepo<TRepos> = PostgreSQLProjectionHandlerContext & {
  repos: TRepos;
};

export const drizzleWithRepoProjection = <EventType extends Event, TRepos>(
  repos: TRepos,
  {
    handle,
    canHandle,
  }: {
    handle: (
      events: PostgresReadEvent<EventType>[],
      context: DrizzleProjectionHandlerContextWithRepo<TRepos>,
    ) => Promise<void>;
    canHandle: CanHandle<EventType>;
  },
) => {
  debugProjection('Creating Drizzle projection with repository injection');
  return postgreSQLProjection<EventType>({
    canHandle,
    handle: async (events, context) => {
      debugProjection('Processing %d events in Drizzle repo projection', events.length);
      await handle(events, {
        ...context,
        repos,
      });
      debugProjection('Drizzle repo projection processed events successfully');
    },
  });
};

// const handlePongo = async (
//   id: string,
//   handle: DocumentHandler<T>,
//   options?: HandleOptions,
// ): Promise<PongoHandleResult<T>> => {
//   const { expectedVersion: version, ...operationOptions } = options ?? {};
//   await ensureCollectionCreated(options);

//   const byId: PongoFilter<T> = { _id: id };

//   const existing = (await collection.findOne(byId, options)) as WithVersion<T>;

//   const expectedVersion = expectedVersionValue(version);

//   if (
//     (existing == undefined && version === 'DOCUMENT_EXISTS') ||
//     (existing == undefined && expectedVersion != undefined) ||
//     (existing != undefined && version === 'DOCUMENT_DOES_NOT_EXIST') ||
//     (existing != undefined && expectedVersion !== null && existing._version !== expectedVersion)
//   ) {
//     return operationResult<PongoHandleResult<T>>(
//       {
//         successful: false,
//         document: existing as T,
//       },
//       { operationName: 'handle', collectionName, errors },
//     );
//   }

//   const result = await handle(existing as T);

//   if (existing === result)
//     return operationResult<PongoHandleResult<T>>(
//       {
//         successful: true,
//         document: existing as T,
//       },
//       { operationName: 'handle', collectionName, errors },
//     );

//   if (!existing && result) {
//     const newDoc = { ...result, _id: id };
//     const insertResult = await collection.insertOne({ ...newDoc, _id: id } as OptionalUnlessRequiredIdAndVersion<T>, {
//       ...operationOptions,
//       expectedVersion: 'DOCUMENT_DOES_NOT_EXIST',
//     });
//     return {
//       ...insertResult,
//       document: {
//         ...newDoc,
//         _version: insertResult.nextExpectedVersion,
//       } as T,
//     };
//   }

//   if (existing && !result) {
//     const deleteResult = await collection.deleteOne(byId, {
//       ...operationOptions,
//       expectedVersion: expectedVersion ?? 'DOCUMENT_EXISTS',
//     });
//     return { ...deleteResult, document: null };
//   }

//   if (existing && result) {
//     const replaceResult = await collection.replaceOne(byId, result, {
//       ...operationOptions,
//       expectedVersion: expectedVersion ?? 'DOCUMENT_EXISTS',
//     });
//     return {
//       ...replaceResult,
//       document: {
//         ...result,
//         _version: replaceResult.nextExpectedVersion,
//       } as T,
//     };
//   }

//   return operationResult<PongoHandleResult<T>>(
//     {
//       successful: true,
//       document: existing as T,
//     },
//     { operationName: 'handle', collectionName, errors },
//   );
// };

// type PongoWithNotNullDocumentEvolve<
//   Document extends PongoDocument,
//   EventType extends Event,
//   EventMetaDataType extends EventMetaDataOf<EventType> &
//     ReadEventMetadataWithGlobalPosition = EventMetaDataOf<EventType> & ReadEventMetadataWithGlobalPosition,
// > =
//   | ((document: Document, event: ReadEvent<EventType, EventMetaDataType>) => Document | null)
//   | ((document: Document, event: ReadEvent<EventType>) => Promise<Document | null>);
// type PongoWithNullableDocumentEvolve<
//   Document extends PongoDocument,
//   EventType extends Event,
//   EventMetaDataType extends EventMetaDataOf<EventType> &
//     ReadEventMetadataWithGlobalPosition = EventMetaDataOf<EventType> & ReadEventMetadataWithGlobalPosition,
// > =
//   | ((document: Document | null, event: ReadEvent<EventType, EventMetaDataType>) => Document | null)
//   | ((document: Document | null, event: ReadEvent<EventType>) => Promise<Document | null>);

// export type PongoMultiStreamProjectionOptions<
//   Document extends PongoDocument,
//   EventType extends Event,
//   EventMetaDataType extends EventMetaDataOf<EventType> &
//     ReadEventMetadataWithGlobalPosition = EventMetaDataOf<EventType> & ReadEventMetadataWithGlobalPosition,
// > = {
//   canHandle: CanHandle<EventType>;

//   collectionName: string;
//   getDocumentId: (event: ReadEvent<EventType>) => string;
// } & (
//   | {
//       evolve: PongoWithNullableDocumentEvolve<Document, EventType, EventMetaDataType>;
//     }
//   | {
//       evolve: PongoWithNotNullDocumentEvolve<Document, EventType, EventMetaDataType>;
//       initialState: () => Document;
//     }
// );

// export const pongoMultiStreamProjection = <
//   Document extends PongoDocument,
//   EventType extends Event,
//   EventMetaDataType extends EventMetaDataOf<EventType> &
//     ReadEventMetadataWithGlobalPosition = EventMetaDataOf<EventType> & ReadEventMetadataWithGlobalPosition,
// >(
//   options: PongoMultiStreamProjectionOptions<Document, EventType, EventMetaDataType>,
// ): PostgreSQLProjectionDefinition => {
//   const { collectionName, getDocumentId, canHandle } = options;

//   return pongoProjection({
//     handle: async (events, { pongo }) => {
//       const collection = pongo.db().collection<Document>(collectionName);

//       for (const event of events) {
//         await collection.handle(getDocumentId(event), async document => {
//           return 'initialState' in options
//             ? await options.evolve(document ?? options.initialState(), event as ReadEvent<EventType, EventMetaDataType>)
//             : await options.evolve(document, event as ReadEvent<EventType, EventMetaDataType>);
//         });
//       }
//     },
//     canHandle,
//   });
// };

// export type PongoSingleStreamProjectionOptions<
//   Document extends PongoDocument,
//   EventType extends Event,
//   EventMetaDataType extends EventMetaDataOf<EventType> &
//     ReadEventMetadataWithGlobalPosition = EventMetaDataOf<EventType> & ReadEventMetadataWithGlobalPosition,
// > = {
//   canHandle: CanHandle<EventType>;

//   collectionName: string;
// } & (
//   | {
//       evolve: PongoWithNullableDocumentEvolve<Document, EventType, EventMetaDataType>;
//     }
//   | {
//       evolve: PongoWithNotNullDocumentEvolve<Document, EventType, EventMetaDataType>;
//       initialState: () => Document;
//     }
// );

// export const pongoSingleStreamProjection = <
//   Document extends PongoDocument,
//   EventType extends Event,
//   EventMetaDataType extends EventMetaDataOf<EventType> &
//     ReadEventMetadataWithGlobalPosition = EventMetaDataOf<EventType> & ReadEventMetadataWithGlobalPosition,
// >(
//   options: PongoSingleStreamProjectionOptions<Document, EventType, EventMetaDataType>,
// ): PostgreSQLProjectionDefinition => {
//   return pongoMultiStreamProjection<Document, EventType, EventMetaDataType>({
//     ...options,
//     getDocumentId: event => event.metadata.streamName,
//   });
// };

export {
  type PostgresEventStore,
  type PostgresEventStoreConnectionOptions,
  type PostgreSQLProjectionHandlerContext,
  type PostgresReadEventMetadata
} from '@event-driven-io/emmett-postgresql';
