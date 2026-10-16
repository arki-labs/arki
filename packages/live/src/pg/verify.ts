/**
 * `verifyLiveTriggers`: does the database publish every table a live procedure
 * reads? Reads the catalogs (`pg_trigger` joined to `pg_class`); for a
 * partitioned table it walks `pg_inherits` down to every partition (leaves
 * and partitioned ones), because a write naming a partition fires only that
 * partition's statement triggers.
 */
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { LiveScopes, TableTag } from '../types.js';
import { LIVE_ERROR_CODES, liveError } from '../errors.js';
import { tagKey } from '../manifest.js';
import { checkScopes } from '../scopes.js';
import {
  checkMaxKeys,
  checkTags,
  liveChannel,
  NOTIFY_FUNCTION,
  NOTIFY_KEYS_FUNCTION,
  NOTIFY_TRUNCATE_FUNCTION,
  SCOPED_TRIGGERS,
  scopedTriggerName,
  triggerName,
} from './migration.js';

export type LiveTriggerProblem = {
  /** The declared table; for `partition-leaf-uncovered` and any problem on a partition's trigger, the partition. */
  readonly tag: TableTag;
  readonly problem:
    | 'missing-table'
    | 'missing-trigger'
    | 'disabled'
    | 'wrong-function'
    /** It fires on other events or at another time, or (scoped) without its transition tables. */
    | 'wrong-events'
    | 'wrong-args'
    /** A partition (a leaf, or a partitioned partition) without its own trigger: a write naming it is not published. */
    | 'partition-leaf-uncovered'
    /** A scoped table (or partition) has no such key column. */
    | 'missing-column'
    /** A scoped table's key column allows NULL: a row without a key would hide its change. */
    | 'nullable-column';
};

/** `pg_trigger.tgtype` of `AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ... FOR EACH STATEMENT`: INSERT 4 | DELETE 8 | UPDATE 16 | TRUNCATE 32; ROW, BEFORE and INSTEAD bits clear. */
const STATEMENT_AFTER_ALL = 60;

const triggerRow = z.object({
  name: z.string(),
  enabled: z.string(),
  type: z.number(),
  /** Which live function it runs, or null for any other. */
  function: z.enum(['table', 'keys', 'truncate']).nullable(),
  args: z.string().nullable(),
  old: z.string().nullable(),
  new: z.string().nullable(),
});

/** One relation that must publish: a declared table, or a partition below one. */
const targetRow = z.object({
  rootSchema: z.string(),
  rootTable: z.string(),
  partition: z.boolean(),
  schema: z.string().nullable(),
  table: z.string().nullable(),
  triggers: z.array(triggerRow),
  /** The scoped key column: null when there is none (or the table is unscoped). */
  column: z.object({ notNull: z.boolean() }).nullable(),
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

/** What one trigger must be. */
type Expected = {
  readonly name: string;
  readonly function: 'table' | 'keys' | 'truncate';
  readonly type: number;
  readonly args: readonly string[];
  readonly old: string | null;
  readonly new: string | null;
};

/** The trigger's first problem, or `undefined` when it is exactly `expected` and fires. */
function inspect(
  row: z.infer<typeof triggerRow> | undefined,
  expected: Expected,
  missing: 'missing-trigger' | 'partition-leaf-uncovered',
): LiveTriggerProblem['problem'] | undefined {
  if (row === undefined) return missing;
  if (row.function !== expected.function) return 'wrong-function';
  if (row.type !== expected.type || row.old !== expected.old || row.new !== expected.new) return 'wrong-events';
  const args = row.args === null ? [] : decodeArgs(row.args);
  if (args.length !== expected.args.length || args.some((arg, index) => arg !== expected.args[index]))
    return 'wrong-args';
  // 'O' fires in a normal session, 'A' always; 'D' never, 'R' only under session_replication_role = replica.
  if (row.enabled !== 'O' && row.enabled !== 'A') return 'disabled';
  return undefined;
}

/**
 * Every way the database fails to publish `tables` for `app`: a missing table (a view or a
 * materialized view counts as missing: publish those with `touch`), a missing, disabled or
 * altered trigger, or a partition (leaf or partitioned) without its own. A scoped table (in
 * `scopes`) needs its four triggers with this `maxKeys` (default 65 536), and its key column must
 * exist and be NOT NULL, on the table and on every partition. Empty when all is well. Reads only.
 */
export async function verifyLiveTriggers(
  db: { execute(query: SQL): Promise<unknown> },
  options: {
    readonly app: string;
    readonly tables: readonly TableTag[];
    readonly scopes?: LiveScopes;
    readonly maxKeys?: number;
  },
): Promise<readonly LiveTriggerProblem[]> {
  const where = 'verifyLiveTriggers()';
  const channel = liveChannel(options.app);
  const name = triggerName(options.app);
  const tables = checkTags(options.tables, where);
  const { byTag } = checkScopes(options.scopes, where);
  const maxKeys = String(checkMaxKeys(options.maxKeys, where));
  if (tables.length === 0) return [];
  const wanted = JSON.stringify(
    tables.map((tag, ord) => ({
      schema: tag.schema,
      table: tag.table,
      column: byTag.get(tagKey(tag))?.column ?? null,
      ord,
    })),
  );
  const names = [name, ...SCOPED_TRIGGERS.map(trigger => scopedTriggerName(options.app, trigger.suffix))];
  const fn = (qualified: string) => sql.raw(`to_regprocedure('${qualified}()')`);

  const targets = rowsOf(
    targetRow,
    await db.execute(sql`
      with recursive declared as (
        select w.schema, w."table", w."column", w.ord, c.oid as relid, c.relkind
        from json_to_recordset(${wanted}::json) as w(schema text, "table" text, "column" text, ord int)
        left join pg_namespace n on n.nspname = w.schema
        left join pg_class c on c.relnamespace = n.oid and c.relname = w."table" and c.relkind in ('r', 'p')
      ), tree as (
        select d.schema, d."table", d."column", i.inhrelid as relid
        from declared d join pg_inherits i on i.inhparent = d.relid
        where d.relkind = 'p'
        union all
        select tree.schema, tree."table", tree."column", i.inhrelid
        from tree join pg_inherits i on i.inhparent = tree.relid
      ), targets as (
        select schema, "table", "column", ord, relid, false as partition from declared
        union all
        select schema, "table", "column", 0, relid, true from tree
      )
      select t.schema as "rootSchema", t."table" as "rootTable", t.partition,
        n.nspname as schema, c.relname as "table",
        coalesce((
          select json_agg(json_build_object(
            'name', tg.tgname, 'enabled', tg.tgenabled::text, 'type', tg.tgtype::int,
            'function', case tg.tgfoid
              when ${fn(NOTIFY_FUNCTION)} then 'table'
              when ${fn(NOTIFY_KEYS_FUNCTION)} then 'keys'
              when ${fn(NOTIFY_TRUNCATE_FUNCTION)} then 'truncate'
            end,
            'args', encode(tg.tgargs, 'hex'), 'old', tg.tgoldtable, 'new', tg.tgnewtable))
          from pg_trigger tg
          where tg.tgrelid = c.oid and not tg.tgisinternal and tg.tgname in (select json_array_elements_text(${JSON.stringify(names)}::json))
        ), '[]'::json) as triggers,
        (
          select json_build_object('notNull', a.attnotnull)
          from pg_attribute a
          where a.attrelid = c.oid and a.attname = t."column" and a.attnum > 0 and not a.attisdropped
        ) as "column"
      from targets t
      left join pg_class c on c.oid = t.relid
      left join pg_namespace n on n.oid = c.relnamespace
      order by t.partition, t.ord, 1, 2, 4, 5
    `),
  );

  const problems: LiveTriggerProblem[] = [];
  const seen = new Set<string>();
  const report = (tag: TableTag, problem: LiveTriggerProblem['problem']): void => {
    const key = `${tagKey(tag)}${problem}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ tag, problem });
  };
  for (const target of targets) {
    const root = { schema: target.rootSchema, table: target.rootTable };
    if (target.schema === null || target.table === null) {
      report(root, 'missing-table');
      continue;
    }
    const tag = target.partition ? { schema: target.schema, table: target.table } : root;
    const missing = target.partition ? 'partition-leaf-uncovered' : 'missing-trigger';
    const byName = new Map(target.triggers.map(row => [row.name, row]));
    const scope = byTag.get(tagKey(root));
    if (scope === undefined) {
      const expected: Expected = {
        name,
        function: 'table',
        type: STATEMENT_AFTER_ALL,
        args: [channel, root.schema, root.table],
        old: null,
        new: null,
      };
      const problem = inspect(byName.get(name), expected, missing);
      if (problem) report(tag, problem);
      continue;
    }
    if (target.column === null) report(tag, 'missing-column');
    else if (!target.column.notNull) report(tag, 'nullable-column');
    for (const trigger of SCOPED_TRIGGERS) {
      const triggerName = scopedTriggerName(options.app, trigger.suffix);
      const expected: Expected = {
        name: triggerName,
        function: trigger.suffix === 'trunc' ? 'truncate' : 'keys',
        type: trigger.type,
        args: [channel, root.schema, root.table, scope.column, maxKeys],
        old: trigger.old ? 'old_rows' : null,
        new: trigger.new ? 'new_rows' : null,
      };
      const problem = inspect(byName.get(triggerName), expected, missing);
      if (problem) report(tag, problem);
    }
  }
  return problems;
}
