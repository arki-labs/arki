import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrderId } from './test-support.js';
import { need } from './handlers.js';
import { j, meta, openDb, order, orderId, OrderPaid, OrderPlaced } from './test-support.js';

type Mail = { readonly orderId: OrderId; readonly idempotencyKey: string };
type Mailer = { send(mail: Mail): void };

let db: PgliteDatabase;
let client: PGlite;
let next = 0;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

const orderMail = j.effect(
  'needs-order-mail',
  order,
  { mailer: need<Mailer>() },
  {
    OrderPaid: (e, { jobId, mailer }) => mailer.send({ orderId: e.entityId, idempotencyKey: jobId }),
  },
);

/** A mailer that keeps what it was asked to send. */
function outbox() {
  const sent: Mail[] = [];
  const mailer: Mailer = { send: mail => void sent.push(mail) };
  return { sent, mailer };
}

async function placeAndPay(journal: Pick<ReturnType<typeof j.compose>, 'write'>) {
  const id = orderId(++next);
  await db.transaction(tx =>
    journal.write(tx, order, `ord_needs_${id}`, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
  );
  await db.transaction(tx =>
    journal.write(tx, order, `ord_needs_${id}`, { meta, events: () => [OrderPaid({ amount: 1 })] }),
  );
  return `ord_needs_${id}` as const;
}

describe('an effect with needs', () => {
  it('gets the service it declared next to the job id, so an effect that sends mail needs no function wrapped around it', async () => {
    const { sent, mailer } = outbox();
    const journal = j.compose({ effects: [orderMail], services: { mailer } });

    const id = await placeAndPay(journal);
    expect(await journal.drain(db)).toBe(1);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.orderId).toBe(id);
    expect(sent[0]?.idempotencyKey).toMatch(/.+/);
  });

  it('keeps its own services in each composed journal, so two journals built from one definition never share a mailer', async () => {
    const first = outbox();
    const second = outbox();
    const one = j.compose({ effects: [orderMail], services: { mailer: first.mailer } });
    j.compose({ effects: [orderMail], services: { mailer: second.mailer } });

    await placeAndPay(one);
    await one.drain(db);

    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(0);
  });

  it('stops `compose` when a need has no service and names the effect and the need, so the mistake shows at boot and not as a job that fails on every try', () => {
    expect(() =>
      // @ts-expect-error -- type test: `orderMail` needs `mailer`, so `compose` without `services` must not compile
      j.compose({ effects: [orderMail] }),
    ).toThrow(
      'journal: effect "needs-order-mail" needs "mailer", but no service with that name was given; pass it as j.compose({ services: { mailer } }), or in a Dot app add it to the `needs` of the feature that lists this effect',
    );
  });

  it.each(['jobId', 'signal', 'db', 'run', 'accept'])(
    'refuses a need named "%s" when the effect is defined, so a service can never hide a built-in part of the handler context',
    name => {
      expect(() => j.effect('needs-reserved', order, { [name]: need<Mailer>() }, {})).toThrow(
        `journal: effect "needs-reserved" has a need named "${name}", but the handler context already has "jobId", "signal", "db", "run" and "accept"; give the need another name`,
      );
    },
  );

  it('shows the same catalog entry as an effect without needs, so tooling that lists effects sees every one', () => {
    const journal = j.compose({ effects: [orderMail], services: { mailer: outbox().mailer } });
    expect(journal.catalog.effects).toEqual(['needs-order-mail']);
  });
});

describe("an effect composed with `services: 'worker'`", () => {
  it('writes and queues its job without the service, because only running the effect needs it: a journal can exist before its services do', async () => {
    const { sent, mailer } = outbox();
    const journal = j.compose({ effects: [orderMail], services: 'worker' });

    const id = await placeAndPay(journal);
    expect(sent).toHaveLength(0);
    expect(await journal.drain(db, { services: () => ({ mailer }) })).toBe(1);

    expect(sent.map(mail => mail.orderId)).toEqual([id]);
  });

  it('refuses a drain or a worker without the service, and claims no job, so the mistake shows once and no job burns its retries', async () => {
    const { sent, mailer } = outbox();
    const journal = j.compose({ effects: [orderMail], services: 'worker' });
    await placeAndPay(journal);
    const message =
      'journal: effect "needs-order-mail" needs "mailer", but no service with that name was given; pass it as j.compose({ services: { mailer } }), or in a Dot app add it to the `needs` of the feature that lists this effect';

    await expect(journal.drain(db)).rejects.toThrow(message);
    expect(() => journal.worker(db)).toThrow(message);
    // The job was never claimed: it runs once the service is given.
    expect(await journal.drain(db, { services: () => ({ mailer }) })).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('asks for the services per handler, so two effects can get two different services under one need name', async () => {
    const first = outbox();
    const second = outbox();
    const otherMail = j.effect(
      'needs-other-mail',
      order,
      { mailer: need<Mailer>() },
      { OrderPaid: (e, { jobId, mailer }) => mailer.send({ orderId: e.entityId, idempotencyKey: jobId }) },
    );
    const journal = j.compose({ effects: [orderMail, otherMail], services: 'worker' });
    await placeAndPay(journal);

    await journal.drain(db, {
      services: ({ name }) => ({ mailer: name === 'needs-order-mail' ? first.mailer : second.mailer }),
    });

    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
  });
});
