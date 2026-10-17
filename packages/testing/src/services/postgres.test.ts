import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { describeServiceContract, leftoverContainers, newRunId } from '../stack/contract.js';
import { postgres, truncateAll } from './postgres.js';

async function query<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<T>(sql);
    return result.rows;
  } finally {
    await client.end();
  }
}

async function buildSchema(url: string): Promise<void> {
  await query(url, `CREATE TABLE note (id serial PRIMARY KEY, body text NOT NULL); INSERT INTO note (body) VALUES ('from the template')`);
}

describeServiceContract({
  name: 'postgres',
  make: () => postgres({ buildSchema }),
  makeFailing: () => postgres({ buildSchema: () => Promise.reject(new Error('migration broke')) }),
  probe: async worker => {
    expect(await query(worker.url, 'SELECT body FROM note')).toEqual([{ body: 'from the template' }]);
  },
  apart: async (a, b) => {
    await query(a.url, `INSERT INTO note (body) VALUES ('only in a')`);
    expect(await query(b.url, `SELECT body FROM note WHERE body = 'only in a'`)).toEqual([]);
  },
});

describe('postgres template', () => {
  it('gives every worker the migrated schema, and truncateAll empties a worker without touching the template', async () => {
    const runId = newRunId();
    const spec = postgres({ buildSchema });
    const started = await spec.start({ runId });
    try {
      const slice = await spec.slice?.(started.value, { runId, workerIndex: 0 });
      if (slice === undefined) throw new Error('postgres must slice');
      await truncateAll(slice.value.url);
      expect(await query(slice.value.url, 'SELECT count(*)::int AS n FROM note')).toEqual([{ n: 0 }]);
      const again = await spec.slice?.(started.value, { runId, workerIndex: 1 });
      expect(await query(again?.value.url ?? '', 'SELECT count(*)::int AS n FROM note')).toEqual([{ n: 1 }]);
      await slice.stop();
      await again?.stop();
    } finally {
      await started.stop();
    }
    expect(await leftoverContainers(runId)).toEqual([]);
  }, 120_000);
});
