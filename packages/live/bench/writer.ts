// Writer overhead: what the live triggers add to a commit, on PGlite (Postgres 17 in WASM, one
// connection, in process).
//
// Three databases with the same tables and rows. `tables` also runs `liveMigration(...).up` (one
// statement trigger per table) and has a listener on the channel, as an app in production does;
// `scoped` the same with every table scoped by its `org` column (200 tenants): per-event triggers
// that read the statement's transition tables and send one NOTIFY per distinct key. `plain` has
// neither. Every write is an UPDATE, so the tables keep their size however long a run times them;
// a statement trigger fires once per statement, whatever the row count. `items` holds 100 000
// rows for the row-count group (1, 1 000, 100 000 rows in one statement). `inserts` starts with
// 20 000 rows and grows by one per call of the one-row insert group (the scoped-trigger cost lane
// that replaced the timed unit test T13: a scoped trigger reads the statement's rows, so its cost
// must not grow with the table).
//
// The databases open on the first call (the contract check), not at import, so `arki-bench list`
// and `check` exit.
import { PGlite } from '@electric-sql/pglite';

import type { LiveScopes, TableTag } from '@arki/live';
import { liveChannel, liveMigration } from '@arki/live/pg';

const APP = 'bench';
export const ROWS = 1000;
export const ITEMS = 100_000;
export const INSERTS = 20_000;
const TENANTS = 200;
const TABLES = ['posts', 'comments', 'users'] as const;
const tags: readonly TableTag[] = [...TABLES, 'items', 'inserts'].map(table => ({ schema: 'public', table }));
const scopes: LiveScopes<'org'> = {
  dimensions: ['org'],
  tables: tags.map(tag => ({ tag, dimension: 'org', column: 'org', kind: 'int' })),
};

const SCHEMA = [
  ...[...TABLES.map(table => [table, ROWS] as const), ['items', ITEMS] as const].map(
    ([table, rows]) => `
  CREATE TABLE ${table} (id int PRIMARY KEY, org int NOT NULL, n int NOT NULL DEFAULT 0);
  INSERT INTO ${table} (id, org) SELECT g, g % ${TENANTS} FROM generate_series(1, ${rows}) AS g;`,
  ),
  `
  CREATE TABLE inserts (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, org int NOT NULL);
  INSERT INTO inserts (org) SELECT g % ${TENANTS} FROM generate_series(1, ${INSERTS}) AS g;`,
].join('\n');

/** Which triggers a database has: none, one per table, or scoped by `org`. */
export type Triggers = 'none' | 'tables' | 'scoped';

export type Writer = {
  /** One row of `posts`. Resolves with the rows it updated. */
  single(id: number): Promise<number>;
  /** Every row of `posts` in one statement. */
  bulk(): Promise<number>;
  /** One row in each of the three tables, one transaction. */
  multi(id: number): Promise<number>;
  /** One new row of tenant `org` in `inserts`, its own transaction. */
  insertOne(org: number): Promise<number>;
  /** The first `count` rows of `items` (each tenant's share) in one statement. */
  items(count: number): Promise<number>;
};

function writer(db: PGlite): Writer {
  return {
    async single(id) {
      const result = await db.query('UPDATE posts SET n = n + 1 WHERE id = $1', [id]);
      return result.affectedRows ?? 0;
    },
    async bulk() {
      const result = await db.query('UPDATE posts SET n = n + 1');
      return result.affectedRows ?? 0;
    },
    multi(id) {
      return db.transaction(async tx => {
        let rows = 0;
        for (const table of TABLES) {
          const result = await tx.query(`UPDATE ${table} SET n = n + 1 WHERE id = $1`, [id]);
          rows += result.affectedRows ?? 0;
        }
        return rows;
      });
    },
    async insertOne(org) {
      const result = await db.query('INSERT INTO inserts (org) VALUES ($1)', [org]);
      return result.affectedRows ?? 0;
    },
    async items(count) {
      const result = await db.query('UPDATE items SET n = n + 1 WHERE id <= $1', [count]);
      return result.affectedRows ?? 0;
    },
  };
}

async function open(triggers: Triggers): Promise<Writer> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  if (triggers === 'none') return writer(db);
  await db.exec(liveMigration({ app: APP, tables: tags, ...(triggers === 'scoped' ? { scopes } : {}) }).up);
  // Prove the triggers publish before anything is timed: one write, one hint.
  let heard: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hint = new Promise<void>((resolve, reject) => {
    heard = resolve;
    timer = setTimeout(() => reject(new Error('the live trigger published no hint within 5 s')), 5000);
  });
  await db.listen(liveChannel(APP), () => heard?.());
  await db.query('UPDATE users SET n = n WHERE id = 1');
  await hint.finally(() => clearTimeout(timer));
  return writer(db);
}

const writers = new Map<Triggers, Promise<Writer>>();

/** The database with `triggers`, opened once per process. */
export function database(triggers: Triggers): Promise<Writer> {
  let made = writers.get(triggers);
  if (made === undefined) {
    made = open(triggers);
    writers.set(triggers, made);
  }
  return made;
}
