import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';

import { buildPgBossAdapter } from './adapter';

const pglite = new PGlite();
const adapter = buildPgBossAdapter(pglite);

afterAll(async () => {
  await pglite.close();
});

describe('buildPgBossAdapter', () => {
  // The adapter pastes values into the SQL text, so every literal must escape
  // its quotes. An array element with an apostrophe used to end the literal
  // early: the query failed, and the rest of the element ran as SQL.
  it('keeps an apostrophe inside an array element as data', async () => {
    const values = ["it's", "x'); select 'injected"];
    const result = await adapter.executeSql('select $1::text[] as v', [values]);
    expect(result.rows).toEqual([{ v: values }]);
  });

  it('keeps an apostrophe inside a scalar string as data', async () => {
    const result = await adapter.executeSql('select $1::text as v', ["it's"]);
    expect(result.rows).toEqual([{ v: "it's" }]);
  });
});
