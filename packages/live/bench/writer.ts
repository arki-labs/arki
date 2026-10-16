// Writer overhead: what the live triggers add to a commit, on PGlite (Postgres 17 in WASM, one
// connection, in process).
//
// Two databases with the same tables and rows. `live` also runs `liveMigration(...).up` (one
// statement trigger per table) and has a listener on the channel, as an app in production does.
// `plain` has neither. Every write is an UPDATE, so the tables keep their size however long a run
// times them; a statement trigger fires once per statement, whatever the row count.
//
// The databases open on the first call (the contract check), not at import, so `arki-bench list`
// and `check` exit.
import { PGlite } from '@electric-sql/pglite';

import type { TableTag } from '@arki/live';
import { liveChannel, liveMigration } from '@arki/live/pg';

const APP = 'bench';
export const ROWS = 1000;
const TABLES = ['posts', 'comments', 'users'] as const;
const tags: readonly TableTag[] = TABLES.map(table => ({ schema: 'public', table }));

const SCHEMA = TABLES.map(
  table => `
  CREATE TABLE ${table} (id int PRIMARY KEY, n int NOT NULL DEFAULT 0);
  INSERT INTO ${table} (id) SELECT g FROM generate_series(1, ${ROWS}) AS g;`,
).join('\n');

export type Writer = {
  /** One row of `posts`. Resolves with the rows it updated. */
  single(id: number): Promise<number>;
  /** Every row of `posts` in one statement. */
  bulk(): Promise<number>;
  /** One row in each of the three tables, one transaction. */
  multi(id: number): Promise<number>;
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
  };
}

async function open(withTriggers: boolean): Promise<Writer> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  if (!withTriggers) return writer(db);
  await db.exec(liveMigration({ app: APP, tables: tags }).up);
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

const writers = new Map<boolean, Promise<Writer>>();

/** The database with (`true`) or without the live triggers, opened once per process. */
export function database(withTriggers: boolean): Promise<Writer> {
  let made = writers.get(withTriggers);
  if (made === undefined) {
    made = open(withTriggers);
    writers.set(withTriggers, made);
  }
  return made;
}
