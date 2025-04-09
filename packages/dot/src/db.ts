import type { CanHandle, Event } from '@event-driven-io/emmett';

import type {
  DrizzleProjectionHandlerContext,
  DrizzleProjectionHandlerContextWithRepo,
  PostgresReadEvent,
} from '@arki/event-sourcing/store';
import { initDb } from '@arki/db/init';
import { drizzleProjection, drizzleWithRepoProjection } from '@arki/event-sourcing/store';

import { env } from './env';
import * as schema from './schema';

export const db = initDb(env.DB_URL, { schema, logger: env.NODE_ENV === 'development' });

export type Database = typeof db;

// Factory function to create all repositories
export function createAppRepositories(db: Database) {
  return {
    // TODO: Add repositories here
  };
}

// Create the single repositories object using the factory
export const repositories = createAppRepositories(db);

export const createProjection = <EventType extends Event>(
  canHandle: CanHandle<EventType>,
  handle: (events: PostgresReadEvent<EventType>[], context: DrizzleProjectionHandlerContext<Schema>) => Promise<void>,
) => drizzleProjection(db, { handle, canHandle });

export const createWithRepoProjection = <EventType extends Event, Key extends keyof typeof repositories>(
  repoKey: Key,
  canHandle: CanHandle<EventType>,
  handle: (
    events: PostgresReadEvent<EventType>[],
    context: DrizzleProjectionHandlerContextWithRepo<(typeof repositories)[Key]>,
  ) => Promise<void>,
) => {
  const repository = repositories[repoKey];
  return drizzleWithRepoProjection(repository, { handle, canHandle });
};
