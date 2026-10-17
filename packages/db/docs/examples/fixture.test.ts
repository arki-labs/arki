import { describe, expect, it } from 'vitest';

import { balance, db, orders, schema, stories } from './fixture.ts';

describe('the docs fixture', () => {
  it('creates every table its Drizzle schema declares', async () => {
    // Why: the DDL is hand-written next to the pgTable definitions. If they drift,
    // README blocks fail with a SQL error that points at the doc, not at the fixture.
    const { orderStatusEnum: _enum, ...tables } = schema;
    expect(Object.keys(tables)).toHaveLength(7);
    for (const [name, table] of Object.entries(tables)) {
      await expect(db.select().from(table).limit(1), name).resolves.toBeInstanceOf(Array);
    }
  });

  it('seeds the rows the README output depends on', async () => {
    // Why: `run expect` blocks print these rows; a changed seed must fail here first.
    expect(await balance('acc_bob')).toBe(100);
    const seeded = await db.select().from(stories);
    expect(seeded.map(story => story.title).toSorted()).toEqual(['first', 'second', 'third']);
    await db.insert(orders).values({ id: 'ord_test' });
    const [order] = await db.select().from(orders);
    expect(order?.status).toBe('open');
  });
});
