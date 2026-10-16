/** The app's database: one in-memory PGlite, published by a plugin as `db`. */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import { plugin } from '@arki/dot/plugin';

export const client = new PGlite();
export const handle = drizzle({ client });

export type Db = typeof handle;
export type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
/** What a repository factory takes: the pool or a transaction. */
export type Database = Db | Transaction;

export const database = plugin({ name: 'database', provides: { db: (): Db => handle } });
