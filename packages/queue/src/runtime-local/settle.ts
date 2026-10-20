/** pg-boss owns state transitions; this adapter supplies the exact Backoff decision. */
import type { PGlite } from '@electric-sql/pglite';
import type { JobAttempt, PgBoss } from 'pg-boss';

import { buildPgBossAdapter } from './adapter.ts';

/**
 * Pinned pg-boss invariant: fail(JobAttempt, {db}) fences the active claim and preserves native
 * dependency/DLQ transitions. Policy, native fail, and millisecond start_after commit together.
 * Never adjust another claim, never throw a handler outcome back into the provider retry layer.
 */
export async function settlePgBossFailure(
  pglite: PGlite,
  boss: PgBoss,
  schema: string,
  name: string,
  attempt: JobAttempt,
  output: object,
  delay?: number,
): Promise<void> {
  if (!/^[a-z_]\w*$/i.test(schema)) throw new Error(`Invalid pg-boss schema name: ${schema}`);
  await pglite.transaction(async tx => {
    const claimed = await tx.query<{ id: string }>(
      `update ${schema}.job set retry_limit = $4, retry_delay = 0, retry_backoff = false
       where id = $1 and name = $2 and state = 'active' and retry_count = $3 returning id`,
      [attempt.id, name, attempt.retryCount, attempt.retryCount + (delay === undefined ? 0 : 1)],
    );
    if (claimed.rows.length === 0) return;
    await boss.fail(name, attempt, output, { db: buildPgBossAdapter(tx) });
    if (delay !== undefined)
      await tx.query(
        `update ${schema}.job set start_after = ${schema}.job_now() + $4 * interval '1 millisecond'
       where id = $1 and name = $2 and state = 'retry' and retry_count = $3`,
        [attempt.id, name, attempt.retryCount, delay],
      );
  });
}
