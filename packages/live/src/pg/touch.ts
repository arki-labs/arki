/**
 * `touch`: publish tags from inside a transaction, for what no trigger sees:
 * a view, a materialized-view refresh, an untracked table. Like a trigger, the
 * hint goes out at commit and not at all on rollback.
 */
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import type { TableTag } from '../schema.js';
import { checkTags, liveChannel } from './migration.js';

/**
 * `await touch(tx, 'blog', { schema: 'public', table: 'post_stats' })` after `refresh materialized view`.
 * The payload is built by the same SQL as the trigger's, so a touch and a trigger for
 * one table in one transaction collapse into one notification.
 */
export async function touch(
  tx: { execute(query: SQL): Promise<unknown> },
  app: string,
  ...tags: readonly TableTag[]
): Promise<void> {
  const channel = liveChannel(app);
  const checked = checkTags(tags, 'touch()');
  if (checked.length === 0) return;
  await tx.execute(sql`
    select pg_notify(${channel},
      json_build_object('v', 1, 'tag', json_build_object('schema', w.schema, 'table', w."table"),
        'txid', pg_current_xact_id()::text)::text)
    from json_to_recordset(${JSON.stringify(checked)}::json) as w(schema text, "table" text)
  `);
}
