/**
 * Open a libSQL database (a local SQLite file, `:memory:`, or a Turso / libSQL
 * server) and wrap it in Drizzle: `createLibsqlDb`.
 *
 * libSQL is the SQLite driver `@arki/db` supports: of the SQLite drivers it is
 * the only one that keeps an async transaction callback correct
 * (docs/arki/research/17-multi-database/spike/results.md). A local database
 * gets a queue so writers take turns instead of failing with `SQLITE_BUSY`
 * (`./libsql-queue.ts`); a remote server does its own locking.
 */
import type { AnyRelations, Logger } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';

import { queueWrites } from './libsql-queue.js';

export type { LibSQLDatabase, LibSQLTransaction } from 'drizzle-orm/libsql';

export type LibsqlDbOptions<TRelations extends AnyRelations> = {
  /** `file:path.db`, `:memory:`, or a `libsql:`, `http(s):` or `ws(s):` server URL. */
  readonly url: string;
  /** The server's auth token (Turso). Not used for local files. */
  readonly authToken?: string | undefined;
  /** Drizzle 1.0 relations config (build via `defineRelations`). */
  readonly relations: TRelations;
  /** Drizzle logger override — `true`/`false` or a custom `Logger` instance. */
  readonly logger?: boolean | Logger;
};

/** Whether `url` names a database in this process: a file or memory, not a server. */
export function isLocalLibsqlUrl(url: string): boolean {
  return url === ':memory:' || url.startsWith('file:');
}

/** The Drizzle handle and the function that closes its client. */
export function createLibsqlDb<TRelations extends AnyRelations>(
  options: LibsqlDbOptions<TRelations>,
): { readonly db: LibSQLDatabase<TRelations>; readonly close: () => void } {
  const client = createClient({
    url: options.url,
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
  });
  const db = drizzle<TRelations>({
    client: isLocalLibsqlUrl(options.url) ? queueWrites(client) : client,
    relations: options.relations,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return {
    db,
    close: () => {
      client.close();
    },
  };
}
