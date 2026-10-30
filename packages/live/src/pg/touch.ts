/**
 * `touch`: publish tags from inside a transaction, for what no trigger sees:
 * a view, a materialized-view refresh, an untracked table. Like a trigger, the
 * hint goes out at commit and not at all on rollback.
 */
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import type { LiveScopes, TableTag } from '../types.js';
import { debugSource } from '../debug.js';
import { LIVE_ERROR_CODES, liveError } from '../errors.js';
import { tagKey } from '../manifest.js';
import { MAX_KEY_BYTES } from '../schema.js';
import { checkScopes, normalizeKey } from '../scopes.js';
import { checkTags, liveChannel, MAX_KEYS } from './migration.js';

/**
 * `await touch(tx, 'blog', { schema: 'public', table: 'post_stats' })` after `refresh materialized view`.
 * A scoped tag takes the changed `keys`: `touch(tx, { app: 'blog', scopes }, { schema, table, keys: [orgId] })`.
 * With `scopes`, a scoped tag without keys or keys on an unscoped tag is E001. A key that is not of the
 * dimension's kind, or is over the size limit, is data: it falls back to a table-wide hint instead of
 * throwing inside your transaction. Keys are written the way Postgres prints them (a UUID in lower
 * case). The payload is built by the same SQL as the trigger's, so a touch and a trigger for one
 * table (and key) in one transaction collapse into one notification.
 */
export async function touch(
  tx: { execute(query: SQL): Promise<unknown> },
  app: string | { readonly app: string; readonly scopes: LiveScopes },
  ...tags: readonly (TableTag & { readonly keys?: readonly string[] })[]
): Promise<void> {
  const where = 'touch()';
  const channel = liveChannel(typeof app === 'string' ? app : app.app);
  const scopes = typeof app === 'string' ? undefined : checkScopes(app.scopes, where);
  const fail = (tag: TableTag, problem: string, remediation: string): never => {
    throw liveError(LIVE_ERROR_CODES.config, `${where}: ${tagKey(tag)}: ${problem}`, remediation);
  };
  const plain: TableTag[] = [];
  const keyed: { schema: string; table: string; key: string }[] = [];
  for (const tag of tags) {
    const [checked] = checkTags([{ schema: tag.schema, table: tag.table }], where);
    if (checked === undefined) continue;
    const scope = scopes?.byTag.get(tagKey(checked));
    if (tag.keys === undefined) {
      if (scope !== undefined) {
        fail(
          checked,
          `scoped by ${scope.dimension}, touched without keys`,
          'Pass the changed keys: { schema, table, keys }.',
        );
      }
      plain.push(checked);
      continue;
    }
    if (scopes !== undefined && scope === undefined) {
      fail(
        checked,
        'touched with keys, but scopes do not scope it',
        'Declare it in liveScopes(), or touch it without keys.',
      );
    }
    if (tag.keys.length === 0 || tag.keys.length > MAX_KEYS) {
      fail(checked, `${tag.keys.length} keys`, `Pass 1 to ${MAX_KEYS} keys; more is a reset, not a hint.`);
    }
    const normalizedKeys: string[] = [];
    let badKey: string | undefined;
    for (const key of tag.keys) {
      const normalized = scope === undefined ? key : normalizeKey(scope.kind, key);
      if (normalized === undefined || new TextEncoder().encode(normalized).length > MAX_KEY_BYTES) {
        badKey ??= key;
      } else {
        normalizedKeys.push(normalized);
      }
    }
    if (badKey !== undefined) {
      // A key is data, not a declaration: throwing here would roll back the caller's write.
      // A table-wide hint is always safe; it only makes clients refetch more than they need.
      debugSource.debug('{tag}: bad key {key}; touching the whole table instead', {
        tag: tagKey(checked),
        key: JSON.stringify(badKey),
      });
      plain.push(checked);
      continue;
    }
    for (const key of normalizedKeys) keyed.push({ ...checked, key });
  }
  if (plain.length > 0) {
    await tx.execute(sql`
      select pg_notify(${channel},
        json_build_object('v', 1, 'tag', json_build_object('schema', w.schema, 'table', w."table"),
          'txid', pg_current_xact_id()::text)::text)
      from json_to_recordset(${JSON.stringify(checkTags(plain, where))}::json) as w(schema text, "table" text)
    `);
  }
  if (keyed.length > 0) {
    await tx.execute(sql`
      select pg_notify(${channel},
        json_build_object('v', 1, 'tag', json_build_object('schema', w.schema, 'table', w."table"),
          'txid', pg_current_xact_id()::text, 'key', w.key)::text)
      from json_to_recordset(${JSON.stringify(keyed)}::json) as w(schema text, "table" text, key text)
    `);
  }
}
