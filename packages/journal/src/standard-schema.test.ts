/**
 * Journal schemas are Standard Schemas. Event data, upcaster steps and meta take any
 * validator that implements the spec, not only zod. Bad data is a `SchemaError`; a
 * schema that cannot run is a `SchemaRunError` and is never mistaken for bad data.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { StandardSchemaV1 } from '@arki/schema';
import { SchemaError, SchemaRunError } from '@arki/schema';

import type { PendingOf } from './types.js';
import { initJournal } from './journal.js';
import { openDb, orderId, orders, tables } from './test-support.js';

/** Hand-written: `{ amount }` as a number or a numeric string in, always a number out. */
const amountSchema: StandardSchemaV1<{ amount: number | string }, { amount: number }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: value => {
      if (typeof value === 'object' && value !== null && 'amount' in value) {
        const amount = Number(value.amount);
        if (Number.isInteger(amount) && amount > 0) return { value: { amount } };
      }
      return { issues: [{ message: 'amount must be a positive whole number', path: [{ key: 'amount' }] }] };
    },
  },
};

/** Hand-written meta: a non-empty `actorId`; other keys are dropped. */
const actorMeta: StandardSchemaV1<{ actorId: string }, { actorId: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: value =>
      typeof value === 'object' &&
      value !== null &&
      'actorId' in value &&
      typeof value.actorId === 'string' &&
      value.actorId !== ''
        ? { value: { actorId: value.actorId } }
        : { issues: [{ message: 'actorId is required', path: ['actorId'] }] },
  },
};

/** Release 1 of the tip event stored cents, as a hand-written schema. */
const centsV1: StandardSchemaV1<{ cents: number }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: value =>
      typeof value === 'object' && value !== null && 'cents' in value && typeof value.cents === 'number'
        ? { value: { cents: value.cents } }
        : { issues: [{ message: 'cents must be a number', path: [{ key: 'cents' }] }] },
  },
};

const j = initJournal({ meta: actorMeta });
const meta = { actorId: 'usr_standard' };

const Opened = j.event('StdOpened', z.object({ customerId: z.string().min(1) }));
const opened = (e: { readonly data: { readonly customerId: string } }) => ({
  customerId: e.data.customerId,
  total: 0,
  status: 'placed' as const,
});
const Paid = j.event('StdPaid', amountSchema);

const TipV1 = j.event('StdTip', centsV1);
const Tip = j.event('StdTip', amountSchema, {
  upcasters: [
    {
      from: centsV1,
      up: v1 => {
        expectTypeOf(v1).toEqualTypeOf<{ cents: number }>();
        return { euros: v1.cents / 100 };
      },
    },
    {
      from: z.object({ euros: z.number() }),
      up: v2 => {
        expectTypeOf(v2).toEqualTypeOf<{ euros: number }>();
        return { amount: Math.round(v2.euros) };
      },
    },
  ],
});

const account = j
  .entity('std_account', orders)
  .create(Opened, opened)
  .on(Paid, (row, e) => ({ total: row.total + e.data.amount }))
  .on(Tip, (row, e) => ({ total: row.total + e.data.amount }));
const accountV1 = j
  .entity('std_account', orders)
  .create(Opened, opened)
  .on(TipV1, (row, e) => ({ total: row.total + e.data.cents }));

let db: PgliteDatabase;
let client: PGlite;
let journal: ReturnType<typeof j.compose>;
let next = 12_000;

beforeAll(async () => {
  ({ db, client } = await openDb());
  journal = j.compose({ tables });
});

afterAll(async () => {
  await client.close();
});

describe('Standard Schema event and meta schemas', () => {
  it('types the constructor from the input and the stored event from the output', () => {
    // Why: callers pass what the schema accepts; reducers read what it returns. A schema that
    // coerces must not leak its loose input type into the log.
    expectTypeOf(Paid).parameter(0).toEqualTypeOf<{ amount: number | string }>();
    expectTypeOf<PendingOf<typeof Paid>['data']>().toEqualTypeOf<{ amount: number }>();
    expect(Paid({ amount: '12' })).toEqual({ type: 'StdPaid', data: { amount: 12 } });
  });

  it('writes and replays events from a hand-written schema, with hand-written meta', async () => {
    // Why: the journal must not depend on zod for persistence: replay re-validates every
    // stored row with the same schema that wrote it.
    const id = orderId(++next);
    await db.transaction(tx =>
      journal.write(tx, account, id, {
        meta: { actorId: 'usr_standard' },
        events: () => [Opened({ customerId: 'cus_std' }), Paid({ amount: '5' })],
      }),
    );
    const replayed = await journal.replay(db, account, id);
    expect(replayed.row?.total).toBe(5);
    expect(replayed.events.map(event => [event.data, event.meta])).toEqual([
      [{ customerId: 'cus_std' }, meta],
      [{ amount: 5 }, meta],
    ]);
  });

  it('reports bad event data and bad meta as SchemaError with the issue path', async () => {
    // Why: callers branch on one error type whatever validator the app picked.
    let thrown: unknown;
    try {
      Paid({ amount: 'x' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SchemaError);
    expect(thrown instanceof SchemaError && thrown.issues[0]?.path).toEqual([{ key: 'amount' }]);

    const id = orderId(++next);
    await expect(
      db.transaction(tx =>
        journal.write(tx, account, id, { meta: { actorId: '' }, events: () => [Opened({ customerId: 'cus_std' })] }),
      ),
    ).rejects.toBeInstanceOf(SchemaError);
    expect(await db.select().from(orders).where(eq(orders.id, id))).toEqual([]);
  });

  it('lifts a row stored under a hand-written old schema through a mixed-vendor upcaster chain', async () => {
    // Why: rows from older releases stay in the log forever; their schemas may come from any vendor.
    const id = orderId(++next);
    await db.transaction(tx =>
      journal.write(tx, accountV1, id, {
        meta,
        events: () => [Opened({ customerId: 'cus_std' }), TipV1({ cents: 250 })],
      }),
    );
    const replayed = await journal.replay(db, account, id);
    expect(replayed.events[1]?.data).toEqual({ amount: 3 });
    expect(replayed.row?.total).toBe(3);
  });

  it('lets a schema that cannot run surface as SchemaRunError, not as bad data', async () => {
    // Why: an async or throwing validator is a bug in the app. Reporting it as a replay
    // failure or as invalid input would hide it behind a "your data is wrong" message.
    const asyncSchema: StandardSchemaV1<{ amount: number }> = {
      '~standard': { version: 1, vendor: 'test', validate: () => Promise.resolve({ value: { amount: 1 } }) },
    };
    expect(() => j.event('StdAsync', asyncSchema)({ amount: 1 })).toThrow(SchemaRunError);

    const id = orderId(++next);
    await db.transaction(tx =>
      journal.write(tx, account, id, {
        meta,
        events: () => [Opened({ customerId: 'cus_std' }), Paid({ amount: 1 })],
      }),
    );
    const throwing: StandardSchemaV1<{ amount: number }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => {
          throw new Error('validator bug');
        },
      },
    };
    const PaidThrowing = j.event('StdPaid', throwing);
    const broken = j
      .entity('std_account', orders)
      .create(Opened, opened)
      .on(PaidThrowing, (row, e) => ({ total: row.total + e.data.amount }));
    await expect(journal.replay(db, broken, id)).rejects.toBeInstanceOf(SchemaRunError);
  });

  it('records `{}` as the meta of a journal declared without a meta schema', async () => {
    // Why: the default meta schema is the journal's own; it must accept the documented
    // `meta: {}` and store nothing the app did not declare.
    const bare = initJournal();
    const BareOpened = bare.event('StdOpened', z.object({ customerId: z.string().min(1) }));
    const bareAccount = bare.entity('std_account', orders).create(BareOpened, opened);
    const bareJournal = bare.compose({ tables });
    const id = orderId(++next);
    await db.transaction(tx =>
      bareJournal.write(tx, bareAccount, id, { meta: {}, events: () => [BareOpened({ customerId: 'cus_std' })] }),
    );
    const replayed = await bareJournal.replay(db, bareAccount, id);
    expect(replayed.events[0]?.meta).toEqual({});
  });
});
