/**
 * The trigger SQL of `@arki/live` (plan § 4): one shared function, one
 * statement trigger per tracked table and app. A scoped table (`liveScopes`)
 * gets one trigger per event instead, reading the statement's transition
 * tables and sending one NOTIFY per distinct key (identical NOTIFYs fold, so
 * each (table, key) is hinted once per transaction), plus a BEFORE TRUNCATE
 * trigger that reads the keys about to go. Generated for review and pasted
 * into a Drizzle custom migration; the library never applies it.
 */
import { z } from 'zod';

import type { LiveScopedTable, LiveScopes, TableTag } from '../types.js';
import { LIVE_ERROR_CODES, liveError } from '../errors.js';
import { tagKey } from '../manifest.js';
import { MAX_KEY_BYTES, tableTagSchema } from '../schema.js';
import { checkScopes } from '../scopes.js';

/** Short and plain, so the channel and the trigger name stay unquoted and far under 63 bytes. */
const appSchema = z.string().regex(/^[a-z0-9_]{1,24}$/);

/** @internal The schema-qualified function every live trigger runs. */
export const NOTIFY_FUNCTION = 'arki_live.notify_table_v1';

/** @internal The function of a scoped table's INSERT, UPDATE and DELETE triggers. */
export const NOTIFY_KEYS_FUNCTION = 'arki_live.notify_keys_v1';

/** @internal The function of a scoped table's BEFORE TRUNCATE trigger. */
export const NOTIFY_TRUNCATE_FUNCTION = 'arki_live.notify_truncate_v1';

/** @internal The default cap on distinct keys per statement: past it the statement sends one overflow (every client resets). */
export const MAX_KEYS = 65_536;

/** @internal A scoped table's four triggers: name suffix, `pg_trigger.tgtype`, and transition tables. */
export const SCOPED_TRIGGERS = [
  // tgtype bits: BEFORE 2 | INSERT 4 | DELETE 8 | UPDATE 16 | TRUNCATE 32; ROW (1) clear.
  { suffix: 'ins', event: 'AFTER INSERT', type: 4, old: false, new: true },
  { suffix: 'upd', event: 'AFTER UPDATE', type: 16, old: true, new: true },
  { suffix: 'del', event: 'AFTER DELETE', type: 8, old: true, new: false },
  { suffix: 'trunc', event: 'BEFORE TRUNCATE', type: 34, old: false, new: false },
] as const;

/** @internal The app's name, or E001. */
export function checkApp(app: string, where: string): string {
  if (!appSchema.safeParse(app).success) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `${where}: app ${JSON.stringify(app)} is not 1-24 characters of [a-z0-9_]`,
      'Name the app in lower case, digits and underscores, e.g. `blog` or `games_platform`.',
    );
  }
  return app;
}

/** @internal Valid, deduplicated tags in their first order, or E001. */
export function checkTags(tags: readonly TableTag[], where: string): readonly TableTag[] {
  const parsed = z.array(tableTagSchema).safeParse(tags);
  if (!parsed.success) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `${where}: bad table tag: ${parsed.error.message}`,
      'A tag is `{ schema, table }`, each 1-63 bytes. Use `tableTag(table)` from `@arki/live/drizzle`.',
    );
  }
  return [...new Map(parsed.data.map(tag => [tagKey(tag), tag])).values()];
}

/** @internal The name of the app's trigger on every table it tracks. */
export function triggerName(app: string): string {
  return `arki_live_${app}`;
}

/** The `NOTIFY` channel of one app: `arki_live_${app}_v1`. */
export function liveChannel(app: string): string {
  return `arki_live_${checkApp(app, 'liveChannel()')}_v1`;
}

/** @internal `"name"`, with `"` doubled. */
export function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** @internal `'text'`, with `'` doubled (`standard_conforming_strings` is on, the default since Postgres 9.1). */
export function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function qualified(tag: TableTag): string {
  return `${identifier(tag.schema)}.${identifier(tag.table)}`;
}

/**
 * Drizzle's migrator sends the text between these markers as separate statements (PGlite refuses
 * several commands in one prepared statement). To `psql` and node-postgres it is a comment.
 */
const BREAKPOINT = '--> statement-breakpoint';

/** `tables`: every tag the migration's triggers publish (the tables, then the leaves' roots). */
export type LiveMigration = { readonly up: string; readonly down: string; readonly tables: readonly TableTag[] };

/** @internal `maxKeys`, or E001. */
export function checkMaxKeys(maxKeys: number | undefined, where: string): number {
  const checked = maxKeys ?? MAX_KEYS;
  if (!Number.isSafeInteger(checked) || checked < 1 || checked > 1_048_576) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `${where}: maxKeys ${String(maxKeys)} is not an integer from 1 to 1048576`,
      'Omit it (65 536), or set the most distinct keys one statement may hint before every client resets.',
    );
  }
  return checked;
}

/** One overflow hint: every client resets. Inlined like `PUBLISH_KEYS`. */
const OVERFLOW = `    PERFORM pg_notify(TG_ARGV[0], json_build_object('v', 1, 'tag', json_build_object('schema', TG_ARGV[1], 'table', TG_ARGV[2]),
      'txid', pg_current_xact_id()::text, 'overflow', true)::text);`;

/**
 * The end of both scoped functions, written once here and inlined into each: a nested call into
 * `arki_live` would need USAGE on that schema for every role that writes a scoped table.
 * TG_ARGV: channel, tag schema, tag table, key column, max keys; `keys` holds up to max + 1.
 */
const PUBLISH_KEYS = `  IF keys IS NULL THEN
    RETURN NULL;
  END IF;
  -- Too many keys, a NULL one, or one past ${MAX_KEY_BYTES} bytes: one overflow, and every client resets.
  IF cardinality(keys) > TG_ARGV[4]::int OR array_position(keys, NULL) IS NOT NULL
      OR EXISTS (SELECT FROM unnest(keys) AS k WHERE octet_length(k) > ${MAX_KEY_BYTES}) THEN
${OVERFLOW}
    RETURN NULL;
  END IF;
  -- One NOTIFY per key: identical ones fold, so each (table, key) is hinted once per transaction.
  PERFORM pg_notify(TG_ARGV[0], json_build_object('v', 1, 'tag', json_build_object('schema', TG_ARGV[1], 'table', TG_ARGV[2]),
    'txid', pg_current_xact_id()::text, 'key', k)::text) FROM unnest(keys) AS k;
  RETURN NULL;`;

const NOTIFY_KEYS_SQL = `CREATE OR REPLACE FUNCTION ${NOTIFY_KEYS_FUNCTION}() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  keys text[];
BEGIN
  EXECUTE format('SELECT array_agg(k) FROM (SELECT DISTINCT k FROM (%s) changed LIMIT %s) distinct_keys',
    CASE TG_OP
      WHEN 'INSERT' THEN format('SELECT %I::text AS k FROM new_rows', TG_ARGV[3])
      WHEN 'DELETE' THEN format('SELECT %I::text AS k FROM old_rows', TG_ARGV[3])
      ELSE format('SELECT %I::text AS k FROM old_rows UNION ALL SELECT %I::text FROM new_rows', TG_ARGV[3], TG_ARGV[3])
    END,
    TG_ARGV[4]::int + 1) INTO keys;
${PUBLISH_KEYS}
END $$;`;

/**
 * Invoker, like every other function here: it reads with the truncating role's own rights. Hint
 * payloads travel over NOTIFY, and any role that can connect may LISTEN on any channel, so a key
 * this role could not read must never be published. When row-level security applies to the role
 * (`row_security_active`), or it may not read the key column, it scans nothing and sends one
 * overflow instead: every client resets. Otherwise it reads the keys about to go, exactly. It runs
 * only as a BEFORE TRUNCATE statement trigger; nobody else may attach it.
 */
const NOTIFY_TRUNCATE_SQL = `CREATE OR REPLACE FUNCTION ${NOTIFY_TRUNCATE_FUNCTION}() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  keys text[];
BEGIN
  IF TG_OP <> 'TRUNCATE' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'STATEMENT' THEN
    RAISE EXCEPTION '${NOTIFY_TRUNCATE_FUNCTION} runs only as a BEFORE TRUNCATE statement trigger';
  END IF;
  -- Rows this role cannot see have keys it must not publish: reset every client instead.
  IF row_security_active(TG_RELID) OR NOT has_column_privilege(TG_RELID, TG_ARGV[3], 'SELECT') THEN
${OVERFLOW}
    RETURN NULL;
  END IF;
  EXECUTE format('SELECT array_agg(k) FROM (SELECT DISTINCT %I::text AS k FROM %I.%I LIMIT %s) distinct_keys',
    TG_ARGV[3], TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[4]::int + 1) INTO keys;
${PUBLISH_KEYS}
END $$;
${BREAKPOINT}
REVOKE ALL ON FUNCTION ${NOTIFY_TRUNCATE_FUNCTION}() FROM PUBLIC;`;

/** @internal The name of one of a scoped table's triggers. */
export function scopedTriggerName(app: string, suffix: (typeof SCOPED_TRIGGERS)[number]['suffix']): string {
  return `${triggerName(app)}_${suffix}`;
}

/**
 * Reviewable SQL for a Drizzle custom migration (`drizzle-kit generate --custom`), one statement
 * per `--> statement-breakpoint`. Never applied by the library.
 *
 * An unscoped table gets one statement trigger. A table in `scopes` gets four: AFTER INSERT,
 * UPDATE and DELETE (Postgres allows one event per trigger with transition tables), each sending
 * one NOTIFY per distinct key of the statement (both keys when a row moves), and BEFORE TRUNCATE,
 * which reads the keys about to go. A statement past `maxKeys` distinct keys (default 65 536), or
 * with a key past 512 bytes, sends one overflow instead and every client resets; the write always
 * commits. Before its triggers, a scoped table is checked: the migration fails unless its key
 * column exists and is NOT NULL.
 *
 * A write straight into a partition (a leaf, or a partitioned partition) fires only that
 * relation's statement triggers, so each one in `leaves` gets its own, publishing its root's tag
 * (and, when the root is scoped, reading the root's key column). The root may be covered by an
 * earlier migration. A new table later is a new migration with only that table: the schema and the
 * functions are created idempotently, and a table that becomes scoped loses its unscoped trigger.
 * `down` drops only this app's triggers; the shared functions stay.
 */
export function liveMigration(options: {
  readonly app: string;
  readonly tables: readonly TableTag[];
  readonly leaves?: readonly { readonly leaf: TableTag; readonly root: TableTag }[];
  readonly scopes?: LiveScopes;
  readonly maxKeys?: number;
}): LiveMigration {
  const where = 'liveMigration()';
  const channel = liveChannel(options.app);
  const name = triggerName(options.app);
  const tables = checkTags(options.tables, where);
  const { byTag } = checkScopes(options.scopes, where);
  const maxKeys = checkMaxKeys(options.maxKeys, where);
  const tracked = new Set(tables.map(tag => tagKey(tag)));
  const leafSeen = new Set<string>();
  const leaves = (options.leaves ?? []).map(({ leaf, root }) => {
    const [checkedLeaf, checkedRoot] = checkTags([leaf, root], where);
    if (!checkedLeaf || !checkedRoot || tracked.has(tagKey(checkedLeaf)) || leafSeen.has(tagKey(checkedLeaf))) {
      throw liveError(
        LIVE_ERROR_CODES.config,
        `${where}: leaf ${JSON.stringify(leaf)} of root ${JSON.stringify(root)} does not fit`,
        'A leaf publishes its root: it differs from the root, is not in `tables`, and is listed once.',
      );
    }
    leafSeen.add(tagKey(checkedLeaf));
    return { on: checkedLeaf, publishes: checkedRoot };
  });
  if (tables.length === 0 && leaves.length === 0) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `${where}: no tables`,
      'Pass the tables your live procedures read: `liveTables(liveManifest(contract))`.',
    );
  }

  const covered = [...tables.map(tag => ({ on: tag, publishes: tag })), ...leaves].map(target => ({
    ...target,
    scope: byTag.get(tagKey(target.publishes)),
  }));
  if (covered.some(({ on, scope }) => `${on.schema}${on.table}${scope?.column ?? ''}`.includes(BREAKPOINT))) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `${where}: a table or column name contains ${JSON.stringify(BREAKPOINT)}`,
      'Drizzle would split the migration inside that name. Rename it.',
    );
  }
  const unscoped = (on: TableTag, publishes: TableTag): string =>
    `CREATE TRIGGER ${name} AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${qualified(on)}\n` +
    `  FOR EACH STATEMENT EXECUTE FUNCTION ${NOTIFY_FUNCTION}(${[channel, publishes.schema, publishes.table].map(text => literal(text)).join(', ')});`;
  const scoped = (on: TableTag, publishes: TableTag, scope: LiveScopedTable): string[] => {
    const args = [channel, publishes.schema, publishes.table, scope.column, String(maxKeys)].map(text => literal(text));
    const column = `${qualified(on)}.${identifier(scope.column)}`;
    return [
      // A column that is missing or nullable would make every write fail, or hide changes: refuse it now.
      `DO $arki_live$ BEGIN\n` +
        `  IF NOT EXISTS (SELECT FROM pg_catalog.pg_attribute WHERE attrelid = ${literal(qualified(on))}::regclass\n` +
        `      AND attname = ${literal(scope.column)} AND attnotnull AND NOT attisdropped) THEN\n` +
        `    RAISE EXCEPTION 'arki_live: scope column % must exist and be NOT NULL', ${literal(column)};\n` +
        `  END IF;\n` +
        `END $arki_live$;`,
      `DROP TRIGGER IF EXISTS ${name} ON ${qualified(on)};`,
      ...SCOPED_TRIGGERS.map(trigger => {
        const referencing = [trigger.old ? 'OLD TABLE AS old_rows' : '', trigger.new ? 'NEW TABLE AS new_rows' : '']
          .filter(Boolean)
          .join(' ');
        const fn = trigger.suffix === 'trunc' ? NOTIFY_TRUNCATE_FUNCTION : NOTIFY_KEYS_FUNCTION;
        return (
          `CREATE TRIGGER ${scopedTriggerName(options.app, trigger.suffix)} ${trigger.event} ON ${qualified(on)}` +
          `${referencing ? ` REFERENCING ${referencing}` : ''}\n` +
          `  FOR EACH STATEMENT EXECUTE FUNCTION ${fn}(${args.join(', ')});`
        );
      }),
    ];
  };
  if (
    covered.some(
      ({ on, scope }) => scope !== undefined && `${on.schema}${on.table}${scope.column}`.includes('$arki_live$'),
    )
  ) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `${where}: a scoped table or column name contains $arki_live$`,
      'The column check quotes names inside $arki_live$ ... $arki_live$. Rename it.',
    );
  }
  const create = covered.flatMap(({ on, publishes, scope }) =>
    scope === undefined ? [unscoped(on, publishes)] : scoped(on, publishes, scope),
  );
  const functions = [
    `CREATE OR REPLACE FUNCTION ${NOTIFY_FUNCTION}() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_notify(TG_ARGV[0],
    json_build_object('v', 1, 'tag', json_build_object('schema', TG_ARGV[1], 'table', TG_ARGV[2]),
      'txid', pg_current_xact_id()::text)::text);
  RETURN NULL;
END $$;`,
    ...(covered.some(({ scope }) => scope !== undefined) ? [NOTIFY_KEYS_SQL, NOTIFY_TRUNCATE_SQL] : []),
  ];
  const up = `CREATE SCHEMA IF NOT EXISTS arki_live;
${BREAKPOINT}
${[...functions, ...create].join(`\n${BREAKPOINT}\n`)}
`;
  const drops = covered.flatMap(({ on, scope }) =>
    (scope === undefined ? [name] : SCOPED_TRIGGERS.map(trigger => scopedTriggerName(options.app, trigger.suffix))).map(
      trigger => `DROP TRIGGER IF EXISTS ${trigger} ON ${qualified(on)};`,
    ),
  );
  const down = `${drops.join(`\n${BREAKPOINT}\n`)}\n`;
  return { up, down, tables: checkTags([...tables, ...leaves.map(({ publishes }) => publishes)], where) };
}
