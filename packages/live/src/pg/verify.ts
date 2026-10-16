/**
 * `verifyLiveTriggers`: does the database publish every table a live procedure
 * reads? Reads the catalogs (`pg_trigger` joined to `pg_class`); for a
 * partitioned table it walks `pg_inherits` down to every leaf, because a write
 * straight into a leaf does not fire the root's statement trigger.
 */
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { TableTag } from '../schema.js';
import { LIVE_ERROR_CODES, liveError } from '../errors.js';
import { tagKey } from '../manifest.js';
import { checkTags, liveChannel, NOTIFY_FUNCTION, triggerName } from './migration.js';

export type LiveTriggerProblem = {
  /** The declared table; for `partition-leaf-uncovered` and any problem on a leaf's trigger, the leaf. */
  readonly tag: TableTag;
  readonly problem:
    | 'missing-table'
    | 'missing-trigger'
    | 'disabled'
    | 'wrong-function'
    | 'wrong-events'
    | 'wrong-args'
    | 'partition-leaf-uncovered';
};

/** `pg_trigger.tgtype` of `AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ... FOR EACH STATEMENT`: INSERT 4 | DELETE 8 | UPDATE 16 | TRUNCATE 32; ROW, BEFORE and INSTEAD bits clear. */
const STATEMENT_AFTER_ALL = 60;

/** The app's trigger on one relation; every column is null when there is none. */
const triggerRow = z.object({
  enabled: z.string().nullable(),
  type: z.number().nullable(),
  rightFunction: z.boolean().nullable(),
  args: z.string().nullable(),
});
const tableRow = triggerRow.extend({ schema: z.string(), table: z.string(), relkind: z.string().nullable() });
const leafRow = triggerRow.extend({
  rootSchema: z.string(),
  rootTable: z.string(),
  schema: z.string(),
  table: z.string(),
});

/** Drizzle's `execute` gives `{ rows }` on node-postgres and PGlite, an array on postgres.js. */
function rowsOf<Row extends z.ZodType>(row: Row, result: unknown): readonly z.infer<Row>[] {
  const parsed = z.union([z.object({ rows: z.array(row) }), z.array(row)]).safeParse(result);
  if (!parsed.success) {
    throw liveError(
      LIVE_ERROR_CODES.triggers,
      `verifyLiveTriggers(): unexpected catalog rows: ${parsed.error.message}`,
      'Pass a Drizzle Postgres database (node-postgres, postgres.js or PGlite).',
    );
  }
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.rows;
}

/** `tgargs` is each argument followed by a NUL byte; it arrives hex-encoded. */
function decodeArgs(hex: string): readonly string[] {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  const args = new TextDecoder().decode(bytes).split('\0');
  args.pop();
  return args;
}

/** The trigger's first problem, or `undefined` when it publishes `expected` on every write. */
function inspect(
  row: z.infer<typeof triggerRow>,
  expected: readonly string[],
  missing: 'missing-trigger' | 'partition-leaf-uncovered',
): LiveTriggerProblem['problem'] | undefined {
  if (row.type === null) return missing;
  if (row.rightFunction !== true) return 'wrong-function';
  if (row.type !== STATEMENT_AFTER_ALL) return 'wrong-events';
  const args = row.args === null ? [] : decodeArgs(row.args);
  if (args.length !== expected.length || args.some((arg, index) => arg !== expected[index])) return 'wrong-args';
  // 'O' fires in a normal session, 'A' always; 'D' never, 'R' only under session_replication_role = replica.
  if (row.enabled !== 'O' && row.enabled !== 'A') return 'disabled';
  return undefined;
}

const triggerSelect = sql`
  t.tgenabled::text as enabled,
  t.tgtype::int as type,
  t.tgfoid = to_regprocedure(${sql.raw(`'${NOTIFY_FUNCTION}()'`)}) as "rightFunction",
  encode(t.tgargs, 'hex') as args
`;

const triggerJoin = (name: string) =>
  sql`left join pg_trigger t on t.tgrelid = c.oid and t.tgname = ${name} and not t.tgisinternal`;

/**
 * Every way the database fails to publish `tables` for `app`: a missing table (a view or a
 * materialized view counts as missing: publish those with `touch`), a missing, disabled or
 * altered trigger, or a partition leaf without its own. Empty when all is well. Reads only.
 */
export async function verifyLiveTriggers(
  db: { execute(query: SQL): Promise<unknown> },
  options: { readonly app: string; readonly tables: readonly TableTag[] },
): Promise<readonly LiveTriggerProblem[]> {
  const channel = liveChannel(options.app);
  const name = triggerName(options.app);
  const tables = checkTags(options.tables, 'verifyLiveTriggers()');
  if (tables.length === 0) return [];
  const wanted = JSON.stringify(tables);

  const declared = rowsOf(
    tableRow,
    await db.execute(sql`
      select w.schema, w."table", c.relkind::text as relkind, ${triggerSelect}
      from json_to_recordset(${wanted}::json) as w(schema text, "table" text)
      left join pg_namespace n on n.nspname = w.schema
      left join pg_class c on c.relnamespace = n.oid and c.relname = w."table" and c.relkind in ('r', 'p')
      ${triggerJoin(name)}
    `),
  );
  const problems: LiveTriggerProblem[] = [];
  const byKey = new Map(declared.map(row => [tagKey(row), row]));
  let partitioned = false;
  for (const tag of tables) {
    const row = byKey.get(tagKey(tag));
    if (!row?.relkind) {
      problems.push({ tag, problem: 'missing-table' });
      continue;
    }
    if (row.relkind === 'p') partitioned = true;
    const problem = inspect(row, [channel, tag.schema, tag.table], 'missing-trigger');
    if (problem) problems.push({ tag, problem });
  }
  if (!partitioned) return problems;

  const leaves = rowsOf(
    leafRow,
    await db.execute(sql`
      with recursive roots as (
        select w.schema, w."table", c.oid as relid
        from json_to_recordset(${wanted}::json) as w(schema text, "table" text)
        join pg_namespace n on n.nspname = w.schema
        join pg_class c on c.relnamespace = n.oid and c.relname = w."table" and c.relkind = 'p'
      ), tree as (
        select r.schema as root_schema, r."table" as root_table, i.inhrelid as relid
        from roots r join pg_inherits i on i.inhparent = r.relid
        union all
        select tree.root_schema, tree.root_table, i.inhrelid
        from tree join pg_inherits i on i.inhparent = tree.relid
      )
      select tree.root_schema as "rootSchema", tree.root_table as "rootTable",
        n.nspname as schema, c.relname as "table", ${triggerSelect}
      from tree
      join pg_class c on c.oid = tree.relid and c.relkind <> 'p'
      join pg_namespace n on n.oid = c.relnamespace
      ${triggerJoin(name)}
      order by 1, 2, 3, 4
    `),
  );
  for (const row of leaves) {
    const problem = inspect(row, [channel, row.rootSchema, row.rootTable], 'partition-leaf-uncovered');
    if (problem) problems.push({ tag: { schema: row.schema, table: row.table }, problem });
  }
  return problems;
}
