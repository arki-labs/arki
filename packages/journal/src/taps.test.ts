import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WakeListener } from './index.js';
import type { OrderId } from './test-support.js';
import { need } from './index.js';
import { j, meta, openDb, order, orderId, OrderPaid, OrderPlaced, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 0;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

/** How an app wires the wake channel on PGlite. On `pg`, a dedicated client runs `LISTEN` and forwards notifications. */
const listenOn =
  (channel: string): WakeListener =>
  onMessage =>
    client.listen(channel, onMessage);

const waitFor = async (check: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
};

describe('the wake channel', () => {
  it('names the channel after the tables, and every commit that recorded events notifies it with the seq range', async () => {
    const journal = j.compose({});
    expect(journal.wakeChannel).toBe('journal_wake');
    const heard: string[] = [];
    const unlisten = await client.listen(journal.wakeChannel, payload => {
      heard.push(payload);
    });
    try {
      const id = orderId(++next);
      const placed = await db.transaction(tx =>
        journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      );
      await waitFor(() => heard.length === 1);
      const seq = placed.events[0]?.seq;
      expect(heard).toEqual([JSON.stringify({ from: seq, to: seq })]);
      // A write that records nothing says nothing.
      await db.transaction(tx => journal.write(tx, order, id, { meta, events: () => [] }));
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(heard).toHaveLength(1);
    } finally {
      await unlisten();
    }
  });

  it('wakes a listening worker from a transaction the caller manages, with no wake() call', async () => {
    // Why: a command inside the app's own transaction cannot wake the worker, because only the
    // caller knows when it commits. NOTIFY is delivered at commit, so the worker hears it anyway.
    const ran: OrderId[] = [];
    const mail = j.effect('listen-mail', order, {
      OrderPaid: e => {
        ran.push(e.entityId);
      },
    });
    const journal = j.compose({ effects: [mail] });
    const worker = journal.worker(db, { pollMs: 60_000, listen: listenOn(journal.wakeChannel) });
    await worker.start();
    try {
      const id = orderId(++next);
      await db.transaction(async tx => {
        await journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] });
        await journal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] });
      });
      await waitFor(() => ran.length === 1);
      expect(ran).toEqual([id]);
    } finally {
      await worker.stop();
    }
  });
});

describe('taps', () => {
  it('fire in the listening worker for every committed event they name, after commit, with the event and the root db; errors are swallowed', async () => {
    // Why: a live page or a cache wants to know now, in every instance, and must never block or
    // fail the command. A tap is that: lossy, after commit, from the wake channel.
    const seen: string[] = [];
    const live = j.tap('live-orders', order, {
      OrderPlaced: (e, { db: root }) => {
        expect(root).toBe(db);
        seen.push(`placed:${e.entityId}:${e.data.customerId}`);
      },
      OrderPaid: () => {
        throw new Error('hub down');
      },
    });
    const journal = j.compose({ taps: [live] });
    expect(journal.catalog.taps).toEqual(['live-orders']);
    expect(() => journal.worker(db)).toThrow('has taps');
    expect(() => journal.worker(db, { taps: false })).not.toThrow();

    const worker = journal.worker(db, { pollMs: 60_000, listen: listenOn(journal.wakeChannel) });
    await worker.start();
    try {
      const id = orderId(++next);
      await journal.run(
        db,
        j.command('placeAndPay', OrderPlaced.schema, async (input, { write }) => {
          await write(order, id, () => [OrderPlaced(input)]);
          await write(order, id, () => [OrderPaid({ amount: 1 })]);
        }),
        { customerId: 'tapped', total: 1 },
        meta,
      );
      await waitFor(() => seen.length === 1);
      expect(seen).toEqual([`placed:${id}:tapped`]);
      // The failing OrderPaid tap changed nothing: the row and the log are as the command left them.
      const [row] = await db.select().from(tables.events).where(eq(tables.events.entityId, id));
      expect(row?.type).toBe('OrderPlaced');
    } finally {
      await worker.stop();
    }
  });

  it('a tap with needs gets them from services, like an effect', async () => {
    const hub: string[] = [];
    const live = j.tap(
      'live-with-hub',
      order,
      { hub: need<string[]>() },
      {
        OrderPlaced: (e, ctx) => {
          ctx.hub.push(e.entityId);
        },
      },
    );
    expect(() => j.compose({ taps: [live], services: {} as { hub: string[] } })).toThrow(
      expect.objectContaining({ code: 'BAD_DEFINITION' }),
    );
    const journal = j.compose({ taps: [live], services: { hub } });
    const worker = journal.worker(db, { pollMs: 60_000, listen: listenOn(journal.wakeChannel) });
    await worker.start();
    try {
      const id = orderId(++next);
      await db.transaction(tx =>
        journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      );
      await waitFor(() => hub.length === 1);
      expect(hub).toEqual([id]);
    } finally {
      await worker.stop();
    }
  });

  it("a tap composed with `services: 'worker'` gets them from the worker, and a worker without them does not start", async () => {
    const hub: string[] = [];
    const live = j.tap(
      'live-with-worker-hub',
      order,
      { hub: need<string[]>() },
      {
        OrderPlaced: (e, ctx) => {
          ctx.hub.push(e.entityId);
        },
      },
    );
    const journal = j.compose({ taps: [live], services: 'worker' });
    const listen = listenOn(journal.wakeChannel);
    expect(() => journal.worker(db, { pollMs: 60_000, listen })).toThrow(
      expect.objectContaining({ code: 'BAD_DEFINITION' }),
    );
    const worker = journal.worker(db, { pollMs: 60_000, listen, services: () => ({ hub }) });
    await worker.start();
    try {
      const id = orderId(++next);
      await db.transaction(tx =>
        journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      );
      await waitFor(() => hub.length === 1);
      expect(hub).toEqual([id]);
    } finally {
      await worker.stop();
    }
  });
});
