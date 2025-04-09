import type { CanHandle, Event } from '@event-driven-io/emmett';

import type {
  DrizzleProjectionHandlerContext,
  DrizzleProjectionHandlerContextWithRepo,
  PostgresReadEvent,
} from '@arki/event-sourcing/store';
import { initDb } from '@arki/db/init';
import { drizzleProjection, drizzleWithRepoProjection } from '@arki/event-sourcing/store';

import { env } from './env';
import { createAuthRepositories } from './features/auth/repository';
import { createContentRepositories } from './features/content/repositories';
import { createFeedRepository } from './features/feed/repository';
import { createSocialRepositories } from './features/social/repositories';
import { createTrackingRepositories } from './features/tracking/repositories';
import * as schema from './schema';

export const db = initDb(env.DB_URL, { schema, logger: env.NODE_ENV === 'development' });

export type Database = typeof db;
export type Schema = typeof schema;

// Define the type for the complete repository structure
export type AppRepositories = {
  auth: ReturnType<typeof createAuthRepositories>;
  content: ReturnType<typeof createContentRepositories>;
  tracking: ReturnType<typeof createTrackingRepositories>;
  social: ReturnType<typeof createSocialRepositories>;
  feed: ReturnType<typeof createFeedRepository>;
};

// Factory function to create all repositories
export function createAppRepositories(db: Database): AppRepositories {
  return {
    auth: createAuthRepositories(db),
    content: createContentRepositories(db),
    tracking: createTrackingRepositories(db),
    social: createSocialRepositories(db),
    feed: createFeedRepository(db),
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
