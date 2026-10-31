/**
 * DOT adapter for `@arki/db` on SQLite through libSQL: a `file:` path,
 * `:memory:`, or a Turso / libSQL server.
 *
 * Its own entry, like Drizzle's `drizzle-orm/libsql` next to
 * `drizzle-orm/node-postgres`: only an app that imports it loads the optional
 * peer `@libsql/client`, so `@arki/db/dot` builds without it.
 *
 * The plugin opens the database at boot, publishes the Drizzle handle as
 * `services.db` (a `LibSQLDatabase<TRelations>`; SQLite has no LISTEN, so no
 * `sessionPool`), and closes the client in `dispose`. `dbMigrations()` from
 * `@arki/db/dot` migrates it at boot.
 *
 * @example
 * ```ts
 * import { defineApp } from '@arki/dot';
 * import { db } from '@arki/db/libsql/dot';
 *
 * export const database = db({ relations, url: () => env.DB_URL }); // DB_URL=file:./data/app.db
 * const app = await defineApp('my-app').infra(database).boot();
 * ```
 */

import type { AnyRelations } from 'drizzle-orm';

import { infra } from '@arki/dot/unit';

import type { LibsqlDbOptions } from '../libsql.js';
import { readUrl } from '../dot-errors.js';
import { createLibsqlDb } from '../libsql.js';

/** Options for `db()`: the relations and logger of {@link LibsqlDbOptions}, with the URL and token read at boot. */
export type LibsqlDbDotOptions<TRelations extends AnyRelations> = Pick<LibsqlDbOptions<TRelations>, 'relations' | 'logger'> & {
  /**
   * `file:path.db`, `:memory:`, or a `libsql:` / `http(s):` / `ws(s):` server URL,
   * read when the app boots. Falls back to `DB_URL` when absent or `undefined`.
   */
  readonly url?: () => string | undefined;
  /** The server's auth token (Turso), read at boot. Not used for local files. */
  readonly authToken?: () => string | undefined;
};

/**
 * Build a DOT plugin that opens a libSQL database at boot and publishes its
 * Drizzle handle as `services.db`. `dispose` closes the client.
 */
export function db<TRelations extends AnyRelations>(options: LibsqlDbDotOptions<TRelations>) {
  let close: (() => void) | undefined;
  return infra({
    name: 'db',
    configure(ctx): undefined {
      ctx.registerService('db', 'db');
    },
    provides: {
      db: () => {
        const opened = createLibsqlDb<TRelations>({
          url: readUrl('libsql', options.url),
          authToken: options.authToken?.(),
          relations: options.relations,
          ...(options.logger === undefined ? {} : { logger: options.logger }),
        });
        close = opened.close;
        return opened.db;
      },
    },
    dispose() {
      const closing = close;
      close = undefined;
      closing?.();
    },
  });
}
