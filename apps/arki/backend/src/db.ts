import { createDb } from '@arki/db/factory';

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
