import type { CanHandle, Event } from '@event-driven-io/emmett';

import { createDb } from '@arki/db/factory';
import type {
  DrizzleProjectionHandlerContext,
  DrizzleProjectionHandlerContextWithRepo,
  PostgresReadEvent,
} from '@arki/event-sourcing/store';
import { drizzleProjection, drizzleWithRepoProjection } from '@arki/event-sourcing/store';

import { createUserRepository } from './features/auth/repository';
import { relations } from './relations';

export const db = createDb({ relations });

export type Db = typeof db;
export type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Database = Db | Transaction;
export type Relations = typeof relations;

export const createRepositories = async (db: Database) => {
  return {
    auth: createUserRepository(db),
    user: createUserRepository(db), // Keep for backward compatibility
  };
};

export const repositories = await createRepositories(db);

export type AppRepositories = typeof repositories;

export const createProjection = <EventType extends Event>(
  canHandle: CanHandle<EventType>,
  handle: (events: PostgresReadEvent<EventType>[], context: DrizzleProjectionHandlerContext<Relations>) => Promise<void>,
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
