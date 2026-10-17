import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { j, meta, openDb, orderId, orders, tables } from './test-support.js';

// One stored event type, `MemoNoteSet`, as three releases of an app declared it.
// Release 1 stored `{ text }`. Release 2 renamed it to `note` and added `by`.
// Release 3 added `pinned`. Rows from every release stay in the log as written.
const MemoOpened = j.event('MemoOpened', z.object({ customerId: z.string() }));
const opened = (e: { readonly data: { readonly customerId: string } }) => ({
  customerId: e.data.customerId,
  total: 0,
  status: 'placed' as const,
});

const noteV1 = z.object({ text: z.string().min(1) });
const noteV2 = z.object({ note: z.string().min(1), by: z.string() });

const NoteSetV1 = j.event('MemoNoteSet', noteV1);
const memoV1 = j
  .entity('memo', orders)
  .create(MemoOpened, opened)
  .on(NoteSetV1, (_row, e) => ({ note: e.data.text }));

const NoteSet = j.event('MemoNoteSet', z.object({ note: z.string().min(1), by: z.string(), pinned: z.boolean() }), {
  erased: data => ({ ...data, note: '[erased]' }),
  upcasters: [
    {
      from: noteV1,
      up: v1 => {
        expectTypeOf(v1).toEqualTypeOf<{ text: string }>();
        return { note: v1.text, by: 'unknown' };
      },
    },
    { from: noteV2, up: v2 => ({ ...v2, pinned: false }) },
  ],
});
const memo = j
  .entity('memo', orders)
  .create(MemoOpened, opened)
  .on(NoteSet, (_row, e) => ({ note: e.data.note }));

const NoteSetBroken = j.event('MemoNoteSet', z.object({ note: z.string() }), {
  upcasters: [
    {
      from: noteV1,
      up: () => {
        throw new Error('cannot lift');
      },
    },
  ],
});
const memoBroken = j
  .entity('memo', orders)
  .create(MemoOpened, opened)
  .on(NoteSetBroken, (_row, e) => ({ note: e.data.note }));

let db: PgliteDatabase;
let client: PGlite;
let journal: ReturnType<typeof j.compose>;
let next = 9000;

beforeAll(async () => {
  ({ db, client } = await openDb());
  journal = j.compose({});
});

afterAll(async () => {
  await client.close();
});

const history = (id: string) =>
  db.select().from(tables.events).where(eq(tables.events.entityId, id)).orderBy(tables.events.version);

/** A memo whose note was written by release 1, at schema version 1. */
async function releaseOneMemo(text = 'buy milk') {
  const id = orderId(++next);
  await db.transaction(tx =>
    journal.write(tx, memoV1, id, {
      meta,
      events: () => [MemoOpened({ customerId: 'cus_memo' }), NoteSetV1({ text })],
    }),
  );
  return id;
}

describe('upcasters', () => {
  it('counts versions from the upcasters and stamps new rows with the current one', async () => {
    // Why: the stored version decides which upcasters a row goes through on read. A new row
    // stamped too low would be lifted again and fail; too high and every reader refuses it.
    expect(NoteSetV1.version).toBe(1);
    expect(NoteSet.version).toBe(3);

    const id = orderId(++next);
    await db.transaction(tx =>
      journal.write(tx, memo, id, {
        meta,
        events: () => [MemoOpened({ customerId: 'cus_memo' }), NoteSet({ note: 'hi', by: 'ana', pinned: true })],
      }),
    );
    const rows = await history(id);
    expect(rows.map(row => [row.type, row.schemaVersion])).toEqual([
      ['MemoOpened', 1],
      ['MemoNoteSet', 3],
    ]);
  });

  it('replays a row written under an old schema through every step, and leaves the stored row as written', async () => {
    // Why: the log is permanent. Old rows must keep replaying after the event changes shape,
    // and reading them must not rewrite history behind the app's back.
    const id = await releaseOneMemo();

    const { row, events } = await journal.replay(db, memo, id);
    expect(events.map(e => e.data)).toEqual([
      { customerId: 'cus_memo' },
      { note: 'buy milk', by: 'unknown', pinned: false },
    ]);
    expect(row).toMatchObject({ note: 'buy milk' });
    expect(await journal.verify(db, memo, id)).toEqual({ ok: true });

    const stored = await history(id);
    expect(stored[1]).toMatchObject({ data: { text: 'buy milk' }, schemaVersion: 1 });
  });

  it('runs only the steps a row still needs', async () => {
    // Why: a row from release 2 already has `note` and `by`. Sending it through the first step
    // again would fail on `text`, or worse, overwrite its author with "unknown".
    const id = await releaseOneMemo();
    const [, noteRow] = await history(id);
    await db
      .update(tables.events)
      .set({ data: { note: 'from release 2', by: 'ana' }, schemaVersion: 2 })
      .where(eq(tables.events.seq, noteRow?.seq ?? 0));

    const { events } = await journal.replay(db, memo, id);
    expect(events[1]?.data).toEqual({ note: 'from release 2', by: 'ana', pinned: false });
  });

  it('gives projections the current shape when they rerun over old rows', async () => {
    // Why: a read model rebuilt from the log is written against today's event type. It must
    // never see a release 1 payload, whatever the row's age.
    const seen: unknown[] = [];
    const notes = j.projection('memo-notes', memo, {
      MemoNoteSet: (_tx, e) => {
        seen.push(e.data);
      },
    });
    const id = await releaseOneMemo('rerun me');
    const [opening] = await history(id);

    await journal.rerun(db, notes, { afterSeq: (opening?.seq ?? 1) - 1 });
    expect(seen).toEqual([{ note: 'rerun me', by: 'unknown', pinned: false }]);
  });

  it('forget erases an old row from its upcast form and stores it at the current version', async () => {
    // Why: the erased form is built from today's shape, so it must be stored as today's
    // version. Stored as version 1, the next read would run the first step on data
    // that has no `text`.
    const id = await releaseOneMemo('call 555-0100');

    expect(await journal.forget(db, memo, id)).toMatchObject({ erased: 1, row: { note: '[erased]' } });
    const stored = await history(id);
    expect(stored[1]).toMatchObject({ data: { note: '[erased]', by: 'unknown', pinned: false }, schemaVersion: 3 });
    expect(await journal.verify(db, memo, id)).toEqual({ ok: true });
  });

  it('refuses a row from a newer release, a row that does not fit its old schema, and a step that throws', async () => {
    // Why: during a rolling deploy, old code reads rows new code wrote. Guessing at their
    // shape would rebuild a wrong row silently. Each failure names the row and the version.
    const fresh = orderId(++next);
    await db.transaction(tx =>
      journal.write(tx, memo, fresh, {
        meta,
        events: () => [MemoOpened({ customerId: 'cus_memo' }), NoteSet({ note: 'new', by: 'ana', pinned: false })],
      }),
    );
    await expect(journal.replay(db, memoV1, fresh)).rejects.toMatchObject({
      code: 'REPLAY_FAILED',
      message: expect.stringContaining('written at schema version 3, but the event declares version 1'),
    });

    const bad = await releaseOneMemo();
    const [, noteRow] = await history(bad);
    await db
      .update(tables.events)
      .set({ data: { text: '' } })
      .where(eq(tables.events.seq, noteRow?.seq ?? 0));
    await expect(journal.replay(db, memo, bad)).rejects.toMatchObject({
      code: 'REPLAY_FAILED',
      message: expect.stringContaining('the data does not fit schema version 1'),
    });

    const thrown = await releaseOneMemo();
    await expect(journal.replay(db, memoBroken, thrown)).rejects.toMatchObject({
      code: 'REPLAY_FAILED',
      message: expect.stringContaining('the upcaster from version 1 threw: cannot lift'),
    });
  });

  it('types each step from its own schema', () => {
    // Why: an upcaster is written once and runs on every old row forever. The compiler is the
    // only reviewer that reads it against the shape those rows really have.
    j.event('Typed', z.object({ n: z.number() }), {
      upcasters: [
        {
          from: z.object({ s: z.string() }),
          // @ts-expect-error `s` is a string: it cannot be multiplied.
          up: old => ({ n: old.s * 2 }),
        },
      ],
    });
  });
});
