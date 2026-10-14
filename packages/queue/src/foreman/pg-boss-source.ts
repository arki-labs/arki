import type { PGlite } from '@electric-sql/pglite';

import type { FailedJobRecord, FailedJobSource } from './source.ts';

const DEFAULT_SCHEMA = 'infra_pg_boss';
const SAFE_SCHEMA = /^[a-z_]\w*$/i;

type FailedRow = {
  id: string;
  name: string;
  retry_count: number;
  revision: string;
  completed_iso: string | null;
  output: unknown;
};

export type PgBossFailedJobSourceOptions = {
  pglite: PGlite;
  /** The pg-boss schema the queue instance runs in. Defaults to the runtime-local default. */
  schema?: string;
};

function messageOf(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && 'message' in output && typeof output.message === 'string') return output.message;
  return JSON.stringify(output);
}

function toRecord(row: FailedRow): FailedJobRecord {
  return {
    id: row.id,
    name: row.name,
    attempts: row.retry_count + 1,
    error: messageOf(row.output),
    failedAt: new Date(row.completed_iso ?? 0),
    revision: row.revision,
  };
}

/**
 * Failed jobs of a runtime-local queue (pg-boss on PGlite), read straight from the pg-boss job table.
 * Retry is one conditional UPDATE that mirrors pg-boss `retry()` (failed -> retry, one more attempt allowed)
 * but only fires while the row still has the revision the approval pinned. That makes a duplicate retry atomic.
 */
export function pgBossFailedJobSource(options: PgBossFailedJobSourceOptions): FailedJobSource {
  const { pglite, schema = DEFAULT_SCHEMA } = options;
  if (!SAFE_SCHEMA.test(schema)) throw new Error(`Invalid pg-boss schema name: ${schema}`);

  // The revision is computed in SQL so the same expression guards the retry UPDATE. completed_on printed by Postgres keeps
  // microseconds that a JS Date would drop; retry_count moves when the job fails again.
  const revisionSql = `left(md5(id::text || ':' || retry_count::text || ':' || coalesce(completed_on::text, '')), 16)`;
  const columns = `id, name, retry_count, ${revisionSql} as revision,
    to_char(completed_on at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as completed_iso, output`;

  return {
    async listFailed({ limit, offset }) {
      const rows = await pglite.query<FailedRow>(
        `select ${columns} from ${schema}.job where state = 'failed'
         order by completed_on desc nulls last, id limit $1 offset $2`,
        [limit, offset],
      );
      const count = await pglite.query<{ total: number }>(
        `select count(*)::int as total from ${schema}.job where state = 'failed'`,
      );
      return { jobs: rows.rows.map(row => toRecord(row)), total: count.rows[0]?.total ?? 0 };
    },

    async getFailed(id) {
      const rows = await pglite.query<FailedRow>(
        `select ${columns} from ${schema}.job where id::text = $1 and state = 'failed'`,
        [id],
      );
      const row = rows.rows[0];
      return row ? toRecord(row) : undefined;
    },

    async retryFailed(id, expectedRevision) {
      const result = await pglite.query<{ id: string }>(
        `update ${schema}.job
           set state = 'retry', retry_limit = retry_limit + 1, completed_on = null,
               start_after = greatest(start_after, ${schema}.job_now())
         where id::text = $1 and state = 'failed' and ${revisionSql} = $2
         returning id`,
        [id, expectedRevision],
      );
      return result.rows.length === 1;
    },
  };
}
