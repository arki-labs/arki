/** Native pg-boss owns the retry transition. Stale workers may never mutate a newer claim. */
import { PGlite } from '@electric-sql/pglite';
import { getConstructionPlans, PgBoss } from 'pg-boss';
import { expect, it } from 'vitest';

import { buildPgBossAdapter } from './adapter.ts';
import { settlePgBossFailure } from './settle.ts';

it('fences stale settlements and persists the exact retry deadline across a queue restart', async () => {
  const db = new PGlite();
  const schema = 'retry_fence';
  await db.exec(getConstructionPlans(schema));
  const createBoss = () => new PgBoss({ db: buildPgBossAdapter(db), schema, createSchema: false, migrate: false });
  let boss = createBoss();
  const name = 'fenced-job';
  try {
    await boss.start();
    await boss.createQueue(name, { retryLimit: 2 });
    const id = await boss.send(name, { n: 1 });
    const [first] = await boss.fetch(name);
    if (first === undefined || id === null) throw new Error('First claim missing');
    await boss.fail(name, first, { message: 'First attempt abandoned' });
    const [second] = await boss.fetch(name);
    if (second === undefined) throw new Error('Second claim missing');
    expect(second.retryCount).toBe(1);
    await settlePgBossFailure(db, boss, schema, name, first, { code: 'stale' });
    const activeRows = await db.query<{ state: string; retry_count: number; retry_limit: number }>(
      `select state,retry_count,retry_limit from ${schema}.job where id = $1`,
      [id],
    );
    const active = activeRows.rows[0];
    expect(active).toMatchObject({ state: 'active', retry_count: 1, retry_limit: 2 });

    const before = Date.now();
    await settlePgBossFailure(db, boss, schema, name, second, { code: 'selected', data: { key: 'k' } }, 375);
    const after = Date.now();
    const read = async () => {
      const rows = await db.query<{ start_after: Date; state: string; output: unknown }>(
        `select start_after,state,output from ${schema}.job where id = $1`,
        [id],
      );
      return rows.rows[0];
    };
    const stored = await read();
    expect(stored?.state).toBe('retry');
    const deadline = stored?.start_after.getTime() ?? 0;
    expect(deadline).toBeGreaterThanOrEqual(before + 375);
    expect(deadline).toBeLessThanOrEqual(after + 375);
    expect(await boss.fetch(name)).toEqual([]);
    await boss.stop();
    boss = createBoss();
    await boss.start();
    expect(await read()).toEqual(stored);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now())));
    const [third] = await boss.fetch(name);
    expect(third).toMatchObject({ id, retryCount: 2 });
  } finally {
    await boss.stop();
    await db.close();
  }
}, 20_000);
