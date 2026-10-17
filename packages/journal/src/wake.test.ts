/**
 * Waking the worker: a committed command should not wait for the next poll.
 * Every worker here polls once a minute, so an effect that runs inside the
 * test's time ran because of a wake. Passes are counted on `journal.drain`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { OrderId } from './test-support.js';
import { j, meta, openDb, order, orderId, OrderNoted, OrderPlaced } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 0;

const POLL_MS = 60_000;

const handled: OrderId[] = [];
const waiting = new Map<OrderId, () => void>();
/** Resolves when the effect has run for this order. */
const whenHandled = (id: OrderId) =>
  new Promise<void>(resolve => {
    waiting.set(id, resolve);
  });

const notify = j.effect('order-notify', order, {
  OrderPlaced: e => {
    handled.push(e.entityId);
    waiting.get(e.entityId)?.();
  },
});

const journal = j.compose({ effects: [notify] });

const orderIdSchema = z.templateLiteral(['ord_', z.string()]);

const placeOrder = j.command(
  'placeOrder',
  z.object({ id: orderIdSchema, fail: z.boolean().default(false) }),
  async (input, { write }) => {
    await write(order, input.id, () => [OrderPlaced({ customerId: 'c', total: 1 })]);
    if (input.fail) throw new Error('refused after the write');
  },
);
/** No effect listens to `OrderNoted`, so this command queues no job. */
const noteOrder = j.command('noteOrder', z.object({ id: orderIdSchema }), (input, { write }) =>
  write(order, input.id, () => [OrderNoted({ note: 'seen' })]),
);

/** A promise the test opens by hand. */
function gate() {
  const lock: { open?: () => void } = {};
  const closed = new Promise<void>(resolve => {
    lock.open = resolve;
  });
  return {
    closed,
    open: () => {
      lock.open?.();
    },
  };
}

/** One turn of the timer queue: every promise chain already started has settled. */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** `journal.drain` replaced by passes that claim nothing and end when the test says so. */
function heldPasses() {
  const passes: ReturnType<typeof gate>[] = [];
  let onPass: (() => void) | undefined;
  const drain = vi.spyOn(journal, 'drain').mockImplementation(async () => {
    const pass = gate();
    passes.push(pass);
    onPass?.();
    await pass.closed;
    return 0;
  });
  const nextPass = () =>
    new Promise<void>(resolve => {
      onPass = resolve;
    });
  return { drain, passes, nextPass };
}

/** A started worker whose first pass found nothing: it now sleeps for a minute. */
async function sleepingWorker() {
  // Nothing left over from another test: the first pass must find no job.
  let left: number;
  do {
    left = await journal.drain(db);
  } while (left > 0);
  const drain = vi.spyOn(journal, 'drain');
  const worker = journal.worker(db, { pollMs: POLL_MS });
  await worker.start();
  await drain.mock.results[0]?.value;
  await tick();
  return { drain, worker };
}

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await client.close();
});

describe('wake', () => {
  it('journal.run on the root database wakes the worker, so the effect does not wait a minute for the poll', async () => {
    const { worker } = await sleepingWorker();
    try {
      const id = orderId(++next);
      const done = whenHandled(id);
      await journal.run(db, placeOrder, { id }, meta);
      await done;
      expect(handled).toContain(id);
    } finally {
      await worker.stop();
    }
  }, 2000);

  it('a wake that lands while a pass is running gets one more pass, because that pass may have looked before the commit', async () => {
    const { drain, passes, nextPass } = heldPasses();
    const worker = journal.worker(db, { pollMs: POLL_MS });
    try {
      const first = nextPass();
      await worker.start();
      await first;
      // Three wakes while the first pass is still running.
      worker.wake();
      worker.wake();
      journal.wake();
      const second = nextPass();
      passes[0]?.open();
      await second;
      passes[1]?.open();
      await tick();
      // One extra pass for all three, then the worker sleeps again.
      expect(drain).toHaveBeenCalledTimes(2);
    } finally {
      await worker.stop();
    }
  }, 2000);

  it('journal.run inside a caller transaction does not wake, because only the caller knows when it commits; journal.wake() after the commit does', async () => {
    const { drain, worker } = await sleepingWorker();
    try {
      const id = orderId(++next);
      const done = whenHandled(id);
      await db.transaction(tx => journal.run(tx, placeOrder, { id }, meta));
      await tick();
      expect(drain).toHaveBeenCalledTimes(1);
      expect(handled).not.toContain(id);

      journal.wake();
      await done;
      expect(handled).toContain(id);
    } finally {
      await worker.stop();
    }
  }, 2000);

  it('a run that rolls back does not wake: its job row was never committed', async () => {
    const { drain, worker } = await sleepingWorker();
    try {
      await expect(journal.run(db, placeOrder, { id: orderId(++next), fail: true }, meta)).rejects.toThrow(
        'refused after the write',
      );
      await tick();
      expect(drain).toHaveBeenCalledTimes(1);
    } finally {
      await worker.stop();
    }
  }, 2000);

  it('a committed run that queued no job does not wake: there is nothing for a pass to find', async () => {
    const id = orderId(++next);
    await journal.run(db, placeOrder, { id }, meta);
    await journal.drain(db);
    const { drain, worker } = await sleepingWorker();
    try {
      await journal.run(db, noteOrder, { id }, meta);
      await tick();
      expect(drain).toHaveBeenCalledTimes(1);
    } finally {
      await worker.stop();
    }
  }, 2000);

  it('stop() resolves as soon as the running pass ends, even with a wake pending, and no pass starts after it', async () => {
    const { drain, passes, nextPass } = heldPasses();
    const worker = journal.worker(db, { pollMs: POLL_MS });
    // Not started yet: a wake has no loop to wake.
    worker.wake();
    await tick();
    expect(drain).not.toHaveBeenCalled();

    const first = nextPass();
    await worker.start();
    await first;
    worker.wake();
    const stopped = worker.stop();
    passes[0]?.open();
    await stopped;

    worker.wake();
    journal.wake();
    await tick();
    expect(drain).toHaveBeenCalledTimes(1);
  }, 2000);
});
