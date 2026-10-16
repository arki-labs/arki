/**
 * The trigger SQL of `@arki/live` (plan § 4): one shared function, one
 * statement trigger per tracked table and app. Generated for review and pasted
 * into a Drizzle custom migration; the library never applies it.
 */
import { z } from 'zod';

import type { TableTag } from '../schema.js';
import { LIVE_ERROR_CODES, liveError } from '../errors.js';
import { tagKey } from '../manifest.js';
import { tableTagSchema } from '../schema.js';

/** Short and plain, so the channel and the trigger name stay unquoted and far under 63 bytes. */
const appSchema = z.string().regex(/^[a-z0-9_]{1,24}$/);

/** @internal The schema-qualified function every live trigger runs. */
export const NOTIFY_FUNCTION = 'arki_live.notify_table_v1';

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

/** `"name"`, with `"` doubled. */
function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** `'text'`, with `'` doubled (`standard_conforming_strings` is on, the default since Postgres 9.1). */
function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function qualified(tag: TableTag): string {
  return `${identifier(tag.schema)}.${identifier(tag.table)}`;
}

/** `tables`: every tag the migration's triggers publish (the tables, then the leaves' roots). */
/**
 * Drizzle's migrator sends the text between these markers as separate statements (PGlite refuses
 * several commands in one prepared statement). To `psql` and node-postgres it is a comment.
 */
const BREAKPOINT = '--> statement-breakpoint';

export type LiveMigration = { readonly up: string; readonly down: string; readonly tables: readonly TableTag[] };

/**
 * Reviewable SQL for a Drizzle custom migration (`drizzle-kit generate --custom`), one statement
 * per `--> statement-breakpoint`. Never
 * applied by the library. A write straight into a partition leaf does not fire the root's
 * statement trigger, so each leaf in `leaves` gets its own trigger, publishing its root's tag
 * (the root may be covered by an earlier migration). A new table later is a new migration
 * with only that table: the schema and the function are created idempotently.
 * `down` drops only this app's triggers; the shared function stays.
 */
export function liveMigration(options: {
  readonly app: string;
  readonly tables: readonly TableTag[];
  readonly leaves?: readonly { readonly leaf: TableTag; readonly root: TableTag }[];
}): LiveMigration {
  const where = 'liveMigration()';
  const channel = liveChannel(options.app);
  const name = triggerName(options.app);
  const tables = checkTags(options.tables, where);
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

  const covered = [...tables.map(tag => ({ on: tag, publishes: tag })), ...leaves];
  if (covered.some(({ on }) => `${on.schema}${on.table}`.includes(BREAKPOINT))) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `${where}: a table name contains ${JSON.stringify(BREAKPOINT)}`,
      'Drizzle would split the migration inside that name. Rename the table.',
    );
  }
  const create = covered.map(
    ({ on, publishes }) =>
      `CREATE TRIGGER ${name} AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${qualified(on)}\n` +
      `  FOR EACH STATEMENT EXECUTE FUNCTION ${NOTIFY_FUNCTION}(${[channel, publishes.schema, publishes.table].map(text => literal(text)).join(', ')});`,
  );
  const up = `CREATE SCHEMA IF NOT EXISTS arki_live;
${BREAKPOINT}
CREATE OR REPLACE FUNCTION ${NOTIFY_FUNCTION}() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_notify(TG_ARGV[0],
    json_build_object('v', 1, 'tag', json_build_object('schema', TG_ARGV[1], 'table', TG_ARGV[2]),
      'txid', pg_current_xact_id()::text)::text);
  RETURN NULL;
END $$;
${BREAKPOINT}
${create.join(`\n${BREAKPOINT}\n`)}
`;
  const down = `${covered.map(({ on }) => `DROP TRIGGER IF EXISTS ${name} ON ${qualified(on)};`).join(`\n${BREAKPOINT}\n`)}\n`;
  return { up, down, tables: checkTags([...tables, ...leaves.map(({ publishes }) => publishes)], where) };
}
