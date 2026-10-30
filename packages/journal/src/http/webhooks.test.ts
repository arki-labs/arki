/**
 * Outgoing webhooks on the journal worker. Why these tests matter: a webhook that leaves before
 * its business write commits announces something that never happened; one sent to the wrong
 * partner leaks their data; one a receiver cannot verify is useless. Signatures are checked with
 * the receiving side from `@arki/http/webhooks`, so sender and receiver must agree for real.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';
import { orThrow } from '@arki/failure';
import { UnsafeUrl } from '@arki/http/public-fetch';
import { standardWebhooks, WebhookCryptoUnavailable } from '@arki/http/webhooks';
import * as webhookSchemes from '@arki/http/webhooks';
import { backoff } from '@arki/resilience';

import type { JobRunner } from '../types.js';
import type { WebhookSenderOptions } from './webhooks.js';
import * as ids from '../id.js';
import { combineRunners } from '../runners.js';
import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';
import { WEBHOOK_ERROR_CODES, webhookSender, webhookTables } from './webhooks.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const hooks = webhookTables();
const journal = j.compose({});
const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const encoder = new TextEncoder();

let db: PgliteDatabase;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await openJournalDb({ ...tables, ...hooks }));
});
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  // Queue rows left by another test would be delivered to this test's receiver.
  await db.delete(tables.jobs).where(sql`true`);
});

type Received = { readonly url: string; readonly headers: Headers; readonly body: string };

/** A fake endpoint answering the statuses in order (the last one repeats). */
function endpoint(...statuses: number[]) {
  const received: Received[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    received.push({ url, headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : '' });
    const status = statuses[Math.min(received.length, statuses.length) - 1] ?? 204;
    return Promise.resolve(new Response(null, { status }));
  };
  return { received, fetch };
}

/** One retry, no wait: a failing delivery is dead on its second try. */
const sender = (fetch: WebhookSenderOptions['fetch'], options: Partial<WebhookSenderOptions> = {}) =>
  webhookSender({
    tables,
    webhooks: hooks,
    encryptionKey,
    fetch,
    retry: backoff.constant(0).upTo(1),
    disableAfter: 2,
    ...options,
  });

async function drainAll(runner: JobRunner): Promise<void> {
  while ((await journal.drain(db, { jobs: runner }).then(result => orThrow(result))) > 0);
}

const attemptsOf = (subscriptionId: string) =>
  db
    .select({ status: hooks.attempts.status, attempt: hooks.attempts.attempt, response: hooks.attempts.responseStatus })
    .from(hooks.attempts)
    .where(eq(hooks.attempts.subscriptionId, subscriptionId))
    .orderBy(hooks.attempts.seq);
const subscriptionRow = async (id: string) => {
  const [row] = await db.select().from(hooks.subscriptions).where(eq(hooks.subscriptions.id, id));
  if (row === undefined) throw new Error(`no subscription ${id}`);
  return row;
};
const dispatchOne = (webhooks: ReturnType<typeof sender>, partner: string, event = 'order.placed') =>
  db.transaction(tx => webhooks.dispatch(tx, { partner, event, payload: { orderId: 'ord_1' } }));

describe('dispatch', () => {
  it('commits with the business write: a rollback leaves no message and no delivery', async () => {
    const webhooks = sender(endpoint().fetch);
    orThrow(await webhooks.subscribe(db, {
      partner: 'p-rollback',
      url: 'https://hooks.example.com/in',
      events: ['order.placed'],
    }));
    await expect(
      db.transaction(async tx => {
        orThrow(await webhooks.dispatch(tx, { partner: 'p-rollback', event: 'order.placed', payload: {} }));
        tx.rollback();
      }),
    ).rejects.toThrow();
    expect(await db.select().from(hooks.messages).where(eq(hooks.messages.partner, 'p-rollback'))).toEqual([]);
    expect(await db.select().from(tables.jobs)).toEqual([]);
  });

  it('queues one delivery per active subscription of that partner and event, and none for anyone else', async () => {
    const webhooks = sender(endpoint().fetch);
    const url = 'https://hooks.example.com/in';
    orThrow(await webhooks.subscribe(db, { partner: 'p-match', url, events: ['order.placed', 'order.paid'] }));
    orThrow(await webhooks.subscribe(db, { partner: 'p-match', url, events: ['order.placed'] }));
    orThrow(await webhooks.subscribe(db, { partner: 'p-match', url, events: ['order.paid'] }));
    const off = orThrow(await webhooks.subscribe(db, { partner: 'p-match', url, events: ['order.placed'] }));
    await webhooks.disable(db, off.id);
    orThrow(await webhooks.subscribe(db, { partner: 'p-other', url, events: ['order.placed'] }));

    const { deliveries } = orThrow(await dispatchOne(webhooks, 'p-match'));
    expect(deliveries).toBe(2);
    expect(await db.select().from(tables.jobs)).toHaveLength(2);
  });

  it('refuses the root database, so a message can never commit without its business write', async () => {
    const webhooks = sender(endpoint().fetch);
    // Called the way untyped JavaScript would call it: the root database, which has no rollback().
    const untyped: Promise<unknown> = Reflect.apply(webhooks.dispatch, undefined, [
      db,
      { partner: 'p', event: 'e', payload: {} },
    ]);
    await expect(untyped).rejects.toMatchObject({
      code: WEBHOOK_ERROR_CODES.notInTransaction,
    });
  });
});

describe('dispatch limits', () => {
  it('refuses a payload over maxPayloadBytes: it would be sent to every subscriber on every try', async () => {
    const webhooks = sender(endpoint().fetch, { maxPayloadBytes: 64 });
    await expect(
      db.transaction(tx => webhooks.dispatch(tx, { partner: 'p-big', event: 'e', payload: { blob: 'x'.repeat(100) } })),
    ).rejects.toMatchObject({ code: WEBHOOK_ERROR_CODES.badInput });
  });
});

describe('delivery', () => {
  it('posts the stored bytes, signed so a Standard Webhooks receiver accepts them', async () => {
    const target = endpoint(204);
    const webhooks = sender(target.fetch);
    const { id, secret } = orThrow(
      await webhooks.subscribe(db, {
        partner: 'p-deliver',
        url: 'https://hooks.example.com/deliver',
        events: ['order.placed'],
      }),
    );
    const { messageId } = orThrow(await dispatchOne(webhooks, 'p-deliver'));
    await drainAll(webhooks.runner);

    expect(target.received).toHaveLength(1);
    const [request] = target.received;
    if (request === undefined) throw new Error('no request');
    expect(request.url).toBe('https://hooks.example.com/deliver');
    expect(JSON.parse(request.body)).toMatchObject({ type: 'order.placed', data: { orderId: 'ord_1' } });
    const verified = orThrow(await standardWebhooks({ secrets: [secret] }).verify({
      headers: request.headers,
      body: encoder.encode(request.body),
    }));
    expect(verified.id).toBe(messageId);
    expect(await attemptsOf(id)).toEqual([{ status: 'delivered', attempt: 1, response: 204 }]);
    expect(await db.select().from(tables.jobs)).toEqual([]);
  });

  it.each([false, true])('keeps signing failure identity and explicit retry policy (retry=%s)', async retry => {
    const target = endpoint(204);
    const policy = backoff.constant(0).upTo(1);
    const webhooks = sender(target.fetch, { retry: retry ? policy.while(WebhookCryptoUnavailable) : policy });
    const { id, secret } = orThrow(await webhooks.subscribe(db, {
      partner: `p-sign-refused-${retry}`,  url: 'https://hooks.example.com/refused', events: ['order.placed'],
    }));
    orThrow(await dispatchOne(webhooks, `p-sign-refused-${retry}`));
    const refusal = WebhookCryptoUnavailable({ cause: new Error('private signing provider') });
    const scheme = standardWebhooks({ secrets: [secret] });
    vi.spyOn(scheme, 'sign').mockResolvedValue(refusal);
    vi.spyOn(webhookSchemes, 'standardWebhooks').mockReturnValue(scheme);
    const run = vi.spyOn(webhooks.runner, 'run');
    await drainAll(webhooks.runner);
    expect(target.received).toHaveLength(0);
    expect(run).toHaveBeenCalledTimes(retry ? 2 : 1);
    for (const result of run.mock.results) expect(await result.value).toBe(refusal);
    expect(await attemptsOf(id)).toEqual(retry ? [
      { status: 'failed', attempt: 1, response: null },
      { status: 'dead', attempt: 2, response: null },
    ] : [{ status: 'dead', attempt: 1, response: null }]);
    const attempts = await db.select().from(hooks.attempts).where(eq(hooks.attempts.subscriptionId, id));
    expect(attempts.every(attempt => attempt.error === refusal.code)).toBe(true);
    const jobs = await db.select().from(tables.jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.deadAt).not.toBeNull();
  });

  it('does not send a partial rotation signature when the second key refuses', async () => {
    const target = endpoint(204);
    const webhooks = sender(target.fetch);
    const { id, secret: oldSecret } = orThrow(await webhooks.subscribe(db, {
      partner: 'p-partial-sign', url: 'https://hooks.example.com/partial', events: ['order.placed'],
    }));
    const { secret: newSecret } = await webhooks.rotateSecret(db, id, { windowSeconds: 3600 });
    orThrow(await dispatchOne(webhooks, 'p-partial-sign'));
    const good = standardWebhooks({ secrets: [newSecret] });
    const refused = standardWebhooks({ secrets: [oldSecret] });
    const refusal = WebhookCryptoUnavailable();
    const goodSign = vi.spyOn(good, 'sign');
    vi.spyOn(refused, 'sign').mockResolvedValue(refusal);
    vi.spyOn(webhookSchemes, 'standardWebhooks').mockReturnValueOnce(good).mockReturnValueOnce(refused);
    const run = vi.spyOn(webhooks.runner, 'run');
    await drainAll(webhooks.runner);
    expect(goodSign).toHaveBeenCalledOnce();
    expect(await run.mock.results[0]?.value).toBe(refusal);
    expect(target.received).toHaveLength(0);
    expect(await attemptsOf(id)).toEqual([{ status: 'dead', attempt: 1, response: null }]);
  });

  it('a failing endpoint: each try is appended, the last one is dead, and the job stays dead for the operator', async () => {
    const webhooks = sender(endpoint(500, 503).fetch);
    const { id } = orThrow(
      await webhooks.subscribe(db, {
        partner: 'p-fail',
        url: 'https://hooks.example.com/fail',
        events: ['order.placed'],
      }),
    );
    orThrow(await dispatchOne(webhooks, 'p-fail'));
    await drainAll(webhooks.runner);

    expect(await attemptsOf(id)).toEqual([
      { status: 'failed', attempt: 1, response: 500 },
      { status: 'dead', attempt: 2, response: 503 },
    ]);
    expect((await journal.jobs(db, { status: 'dead' })).jobs).toHaveLength(1);
    expect(await subscriptionRow(id)).toMatchObject({ status: 'active', deadLetters: 1 });
  });

  it('a refused URL is dead on its first try: publicFetch refuses it the same way every time', async () => {
    // The host turned private after subscribe (a DNS change); three retries would all be refused too.
    const webhooks = sender(() => Promise.reject(new TypeError('refused', { cause: UnsafeUrl({ reason: 'private_address' }) })), {
      retry: backoff.constant(0).upTo(3),
    });
    const { id } = orThrow(
      await webhooks.subscribe(db, {
        partner: 'p-refused',
        url: 'https://hooks.example.com/refused',
        events: ['order.placed'],
      }),
    );
    orThrow(await dispatchOne(webhooks, 'p-refused'));
    await drainAll(webhooks.runner);

    expect(await attemptsOf(id)).toEqual([{ status: 'dead', attempt: 1, response: null }]);
    expect((await journal.jobs(db, { status: 'dead' })).jobs).toHaveLength(1);
    expect(await subscriptionRow(id)).toMatchObject({ deadLetters: 1 });
  });

  it('dead deliveries in a row disable the subscription; a success in between resets the count', async () => {
    const flaky = endpoint(500, 500, 204, 500);
    const webhooks = sender(flaky.fetch);
    const { id } = orThrow(
      await webhooks.subscribe(db, {
        partner: 'p-disable',
        url: 'https://hooks.example.com/flaky',
        events: ['order.placed'],
      }),
    );
    orThrow(await dispatchOne(webhooks, 'p-disable')); // 500, 500: dead
    await drainAll(webhooks.runner);
    orThrow(await dispatchOne(webhooks, 'p-disable')); // 204: delivered, count reset
    await drainAll(webhooks.runner);
    expect(await subscriptionRow(id)).toMatchObject({ status: 'active', deadLetters: 0 });

    orThrow(await dispatchOne(webhooks, 'p-disable')); // 500, 500: dead
    await drainAll(webhooks.runner);
    orThrow(await dispatchOne(webhooks, 'p-disable')); // 500, 500: dead, the second in a row
    await drainAll(webhooks.runner);
    const row = await subscriptionRow(id);
    expect(row).toMatchObject({ status: 'disabled', deadLetters: 2 });
    expect(row.disabledAt).toBeInstanceOf(Date);

    const afterDisable = orThrow(await dispatchOne(webhooks, 'p-disable'));
    expect(afterDisable.deliveries).toBe(0);
  });

  it('a delivery queued before its subscription was disabled is skipped, not sent', async () => {
    const target = endpoint(204);
    const webhooks = sender(target.fetch);
    const { id } = orThrow(
      await webhooks.subscribe(db, {
        partner: 'p-skip',
        url: 'https://hooks.example.com/skip',
        events: ['order.placed'],
      }),
    );
    orThrow(await dispatchOne(webhooks, 'p-skip'));
    await webhooks.disable(db, id);
    await drainAll(webhooks.runner);
    expect(target.received).toEqual([]);
    expect(await attemptsOf(id)).toEqual([{ status: 'skipped', attempt: 1, response: null }]);
  });
});

describe('replay', () => {
  it('sends a dead message again with the same webhook-id, so the receiver can dedupe it', async () => {
    const target = endpoint(500, 500, 204);
    const webhooks = sender(target.fetch);
    const { id } = orThrow(
      await webhooks.subscribe(db, {
        partner: 'p-replay',
        url: 'https://hooks.example.com/replay',
        events: ['order.placed'],
      }),
    );
    const { messageId } = orThrow(await dispatchOne(webhooks, 'p-replay'));
    await drainAll(webhooks.runner);
    orThrow(await webhooks.replay(db, { messageId, subscriptionId: id }));
    await drainAll(webhooks.runner);

    expect(target.received.map(request => request.headers.get('webhook-id'))).toEqual([
      messageId,
      messageId,
      messageId,
    ]);
    const tries = await attemptsOf(id);
    expect(tries.map(attempt => attempt.status)).toEqual(['failed', 'dead', 'delivered']);
  });

  it("refuses to send one partner's message to another partner's endpoint", async () => {
    const webhooks = sender(endpoint().fetch);
    orThrow(await webhooks.subscribe(db, { partner: 'p-a', url: 'https://a.example.com/in', events: ['order.placed'] }));
    const other = orThrow(
      await webhooks.subscribe(db, {
        partner: 'p-b',
        url: 'https://b.example.com/in',
        events: ['order.placed'],
      }),
    );
    const { messageId } = orThrow(await dispatchOne(webhooks, 'p-a'));
    await expect(webhooks.replay(db, { messageId, subscriptionId: other.id })).rejects.toMatchObject({
      code: WEBHOOK_ERROR_CODES.otherPartner,
    });
  });
});

describe('secrets', () => {
  it('during a rotation window both secrets sign, so a receiver holding either accepts', async () => {
    const target = endpoint(204);
    const webhooks = sender(target.fetch);
    const { id, secret: oldSecret } = orThrow(
      await webhooks.subscribe(db, {
        partner: 'p-rotate',
        url: 'https://hooks.example.com/rotate',
        events: ['order.placed'],
      }),
    );
    const { secret: newSecret } = await webhooks.rotateSecret(db, id, { windowSeconds: 3600 });
    expect(newSecret).not.toBe(oldSecret);
    expect(await subscriptionRow(id)).toMatchObject({ secretVersion: 2 });
    orThrow(await dispatchOne(webhooks, 'p-rotate'));
    await drainAll(webhooks.runner);

    const [request] = target.received;
    if (request === undefined) throw new Error('no request');
    expect(request.headers.get('webhook-signature')?.split(' ')).toHaveLength(2);
    for (const secret of [oldSecret, newSecret]) {
      await expect(
        standardWebhooks({ secrets: [secret] }).verify({
          headers: request.headers,
          body: encoder.encode(request.body),
        }),
      ).resolves.toHaveProperty('id');
    }
  });

  it('after the window only the new secret signs', async () => {
    const target = endpoint(204);
    const webhooks = sender(target.fetch);
    const { id, secret: oldSecret } = orThrow(
      await webhooks.subscribe(db, {
        partner: 'p-rotated',
        url: 'https://hooks.example.com/rotated',
        events: ['order.placed'],
      }),
    );
    await webhooks.rotateSecret(db, id, { windowSeconds: 0 });
    orThrow(await dispatchOne(webhooks, 'p-rotated'));
    await drainAll(webhooks.runner);
    const [request] = target.received;
    if (request === undefined) throw new Error('no request');
    expect(request.headers.get('webhook-signature')?.split(' ')).toHaveLength(1);
    await expect(
      standardWebhooks({ secrets: [oldSecret] }).verify({
        headers: request.headers,
        body: encoder.encode(request.body),
      }),
    ).resolves.toMatchObject({ status: 401 });
  });

  it('are sealed at rest, and a sealed secret copied onto another subscription does not open', async () => {
    const target = endpoint(204);
    const webhooks = sender(target.fetch);
    const first = orThrow(
      await webhooks.subscribe(db, {
        partner: 'p-seal',
        url: 'https://hooks.example.com/one',
        events: ['order.placed'],
      }),
    );
    const second = orThrow(
      await webhooks.subscribe(db, {
        partner: 'p-seal',
        url: 'https://hooks.example.com/two',
        events: ['other.event'],
      }),
    );
    const stored = await subscriptionRow(first.id);
    expect(stored.secret).not.toContain(first.secret.slice('whsec_'.length));

    // Someone with write access to the table swaps the first secret onto the second row.
    await db.update(hooks.subscriptions).set({ secret: stored.secret }).where(eq(hooks.subscriptions.id, second.id));
    orThrow(await db.transaction(tx => webhooks.dispatch(tx, { partner: 'p-seal', event: 'other.event', payload: {} })));
    await drainAll(webhooks.runner);
    expect(target.received).toEqual([]);
    expect((await journal.jobs(db, { status: 'dead' })).jobs).toHaveLength(1);
  });

  it('a wrong encryption key is refused when the sender is built', () => {
    expect(() => webhookSender({ tables, webhooks: hooks, encryptionKey: 'c2hvcnQ=' })).toThrow(
      expect.objectContaining({ code: WEBHOOK_ERROR_CODES.badEncryptionKey }),
    );
  });
});

describe('subscribe', () => {
  it('takes public https URLs only', async () => {
    const webhooks = sender(endpoint().fetch);
    for (const url of ['http://hooks.example.com/in', 'https://127.0.0.1/in', 'https://u:p@hooks.example.com/in']) {
      await expect(webhooks.subscribe(db, { partner: 'p-url', url, events: ['e'] })).rejects.toMatchObject({
        code: WEBHOOK_ERROR_CODES.badInput,
      });
    }
  });
});

describe('combineRunners', () => {
  it('runs webhook deliveries beside another runner on one worker, and refuses two owners of one name', async () => {
    const target = endpoint(204);
    const webhooks = sender(target.fetch);
    orThrow(await webhooks.subscribe(db, {
      partner: 'p-combo',
      url: 'https://hooks.example.com/combo',
      events: ['order.placed'],
    }));
    const ran: string[] = [];
    const other: JobRunner = {
      names: ['demo.v1'],
      run: job => {
        ran.push(job.id);
        return Promise.resolve();
      },
      // Never retried: the test only needs it to run once.
      retryDelay: () => 0,
    };
    await db.insert(tables.jobs).values({ id: 'job_demo', kind: 'queue', jobName: 'demo.v1', args: {} });
    orThrow(await dispatchOne(webhooks, 'p-combo'));
    await drainAll(combineRunners(other, webhooks.runner));
    expect(ran).toEqual(['job_demo']);
    expect(target.received).toHaveLength(1);

    expect(() => combineRunners(other, other)).toThrow(expect.objectContaining({ code: 'BAD_DEFINITION' }));
  });
});

describe('webhook entropy ownership', () => {
  it('returns a subscription-ID refusal before storing or sealing a subscription', async () => {
    const webhooks = sender(endpoint().fetch);
    vi.stubGlobal('crypto', null);
    const result = await webhooks.subscribe(db, {
      partner: 'entropy-subscribe',
      url: 'https://hooks.example.com/in',
      events: ['e'],
    });
    expect(RandomSourceUnavailable.is(result)).toBe(true);
    expect(
      await db.select().from(hooks.subscriptions).where(eq(hooks.subscriptions.partner, 'entropy-subscribe')),
    ).toEqual([]);
  });

  it('rolls a message back when a delivery job ID fails, and replay returns the same refusal', async () => {
    const webhooks = sender(endpoint().fetch);
    const subscription = orThrow(
      await webhooks.subscribe(db, {
        partner: 'entropy-dispatch',
        url: 'https://hooks.example.com/in',
        events: ['order.placed'],
      }),
    );
    const refused = RandomSourceUnavailable();
    const factory = vi.spyOn(ids, 'jobId').mockReturnValue(refused);
    expect(await dispatchOne(webhooks, 'entropy-dispatch')).toBe(refused);
    expect(await db.select().from(hooks.messages).where(eq(hooks.messages.partner, 'entropy-dispatch'))).toEqual([]);
    expect(await db.select().from(tables.jobs)).toEqual([]);
    factory.mockRestore();
    const message = orThrow(await dispatchOne(webhooks, 'entropy-dispatch'));
    vi.spyOn(ids, 'jobId').mockReturnValue(refused);
    const before = await db.select().from(tables.jobs);
    expect(await webhooks.replay(db, { messageId: message.messageId, subscriptionId: subscription.id })).toBe(refused);
    expect(await db.select().from(tables.jobs)).toEqual(before);
  });
});
