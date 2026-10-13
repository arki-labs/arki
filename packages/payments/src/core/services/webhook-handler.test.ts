/**
 * WebhookHandler: every event runs, and runs once at a time
 *
 * Payment providers resend a webhook until it is answered with success, and
 * two copies can arrive at the same time. Each run of an event changes what a
 * customer is charged or can use, so:
 * - a copy must never run an event that is running or done;
 * - a failed or crashed event must run again on the next resend, or it is lost;
 * - an event that keeps failing must stop the resends after `maxRetries`.
 *
 * The claim and the takeover run the shipped SQL from `webhook-claims.ts` on
 * PGlite, against the real `webhook_events` table and its unique index. The
 * other store methods are plain updates mirrored here, as
 * `service-test-support.ts` does for the repository reads. The validator is a
 * stub: signature checks are covered in `webhook-security.test.ts`.
 */
import type { PGlite } from '@electric-sql/pglite';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { add, now, sub } from '@arki/date';

import type { AppDb } from '../../test-support.js';
import type { WebhookEvent, WebhookValidationResult } from '../types.js';
import type { WebhookEventStore, WebhookProcessingResult, WebhookValidator } from './webhook-handler.js';
import type { WebhookValidationOptions } from './webhook-security.js';
import { core, openDb } from '../../test-support.js';
import { createWebhookId } from '../primitives.js';
import { claimWebhookEvent, reclaimWebhookEvent } from '../webhook-claims.js';
import { WebhookHandler } from './webhook-handler.js';

const { webhookEvents } = core;

let db: AppDb;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

// `retryFailedWebhooks` reads every unprocessed row, so each test starts empty.
beforeEach(async () => {
  await db.delete(webhookEvents).where(isNotNull(webhookEvents.id));
});

/** The one row a query returned. */
function only(rows: WebhookEvent[], what: string): WebhookEvent {
  const [row] = rows;
  if (!row) {
    throw new Error(`webhook event not found (${what})`);
  }
  return row;
}

/** The event store on the test database. */
function storeOn(database: AppDb): WebhookEventStore {
  return {
    claimWebhookEvent: (data) => claimWebhookEvent(database, webhookEvents, data),
    reclaimWebhookEvent: (id, seen, cutoff) => reclaimWebhookEvent(database, webhookEvents, id, seen, cutoff),
    async markWebhookEventAsProcessed(id) {
      const rows = await database
        .update(webhookEvents)
        .set({ processed: true, processedAt: now(), updatedAt: now() })
        .where(eq(webhookEvents.id, id))
        .returning();
      return only(rows, 'mark processed');
    },
    async findUnprocessedWebhookEvents(limit = 100) {
      return database
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.processed, false))
        .orderBy(asc(webhookEvents.createdAt))
        .limit(limit);
    },
    async updateWebhookEvent(id, data) {
      const rows = await database
        .update(webhookEvents)
        .set({ ...data, updatedAt: now() })
        .where(eq(webhookEvents.id, id))
        .returning();
      return only(rows, 'update');
    },
  };
}

/** A validator that returns `result` and records the options it was called with. */
function validatorReturning(result: WebhookValidationResult) {
  const calls: WebhookValidationOptions[] = [];
  const validator: WebhookValidator = {
    validateWebhook(_provider, _payload, _signature, _timestamp, _sourceIp, _secret, options = {}) {
      calls.push(options);
      return Promise.resolve(result);
    },
  };
  return { validator, calls };
}

const valid: WebhookValidationResult = {
  isValid: true,
  provider: 'stripe',
  eventType: 'subscription.created',
  data: { object: 'subscription' },
};

/**
 * A handler with the library defaults on the test database, counting how
 * often the event runs. `body` is what each run does after it is counted.
 */
function countingHandler(
  options: { result?: WebhookValidationResult; skipIpValidation?: boolean; maxRetries?: number } = {},
  body: (run: number) => Promise<void> = () => Promise.resolve(),
) {
  const { validator, calls } = validatorReturning(options.result ?? valid);
  const handler = new WebhookHandler(storeOn(db), validator, {
    ...(options.skipIpValidation === undefined ? {} : { skipIpValidation: options.skipIpValidation }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });
  const counter = { runs: 0 };
  handler.registerEventHandler('subscription.created', async () => {
    counter.runs += 1;
    await body(counter.runs);
  });
  return { handler, counter, calls };
}

/** A body whose first run fails, and later runs succeed. */
function failingOnce(run: number): Promise<void> {
  return run === 1 ? Promise.reject(new Error('downstream unavailable')) : Promise.resolve();
}

function deliver(handler: WebhookHandler, eventId: string) {
  return handler.processWebhook(
    'stripe',
    JSON.stringify({ id: eventId, type: 'customer.subscription.created' }),
    't=0,v1=stub',
    '0',
    '203.0.113.7',
    'whsec_test',
  );
}

async function rowFor(eventId: string): Promise<WebhookEvent> {
  return only(
    await db.select().from(webhookEvents).where(eq(webhookEvents.providerEventId, eventId)),
    eventId,
  );
}

/** Store a row as an earlier attempt left it. */
async function seedRow(eventId: string, row: { lastAttemptAt: WebhookEvent['lastAttemptAt']; errorMessage?: string }) {
  const { event } = await claimWebhookEvent(db, webhookEvents, {
    id: createWebhookId(),
    provider: 'stripe',
    eventType: 'subscription.created',
    providerEventId: eventId,
    data: {},
    processed: false,
    attempts: 1,
    sourceIp: '203.0.113.7',
    ...row,
  });
  return event;
}

const ran = { success: true };
const busy = { success: false, retryable: true, error: 'Event is being processed' };
const done = { success: true, error: 'Event already processed' };

/** A copy that lost a race either waits for a resend or sees the winner's result. */
function isBusyOrDone(result: WebhookProcessingResult): boolean {
  return result.error === busy.error ? result.retryable === true : result.success && result.error === done.error;
}

describe('WebhookHandler: one run at a time', () => {
  it('runs a new event once when copies arrive at the same time', async () => {
    const { handler, counter } = countingHandler();

    const results = await Promise.all([
      deliver(handler, 'evt_concurrent'),
      deliver(handler, 'evt_concurrent'),
      deliver(handler, 'evt_concurrent'),
    ]);

    expect(counter.runs).toBe(1);
    const winners = results.filter((r) => r.success && r.error === undefined);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r !== winners[0]).every((r) => isBusyOrDone(r))).toBe(true);
    expect(await rowFor('evt_concurrent')).toMatchObject({ processed: true, attempts: 1 });
  });

  it('asks a copy that arrives mid-run to be resent, and does not run it', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Only the first run is held open, so a wrong second run fails the test
    // instead of hanging it.
    const { handler, counter } = countingHandler({}, async (run) => {
      if (run === 1) {
        entered.resolve();
        await release.promise;
      }
    });

    const first = deliver(handler, 'evt_in_flight');
    await entered.promise;

    // Not a success: if the running attempt then crashed, a 2xx here would
    // stop the resends and lose the event.
    expect(await deliver(handler, 'evt_in_flight')).toMatchObject(busy);
    expect(counter.runs).toBe(1);

    release.resolve();
    expect(await first).toMatchObject(ran);
    expect(counter.runs).toBe(1);
    expect(await rowFor('evt_in_flight')).toMatchObject({ processed: true, attempts: 1 });
  });

  it('does not run a copy that leaves a fresh attempt alone (stored row, inside the lease)', async () => {
    const { handler, counter } = countingHandler();
    await seedRow('evt_fresh', { lastAttemptAt: now() });

    expect(await deliver(handler, 'evt_fresh')).toMatchObject(busy);
    expect(counter.runs).toBe(0);
    expect(await rowFor('evt_fresh')).toMatchObject({ processed: false, attempts: 1 });
  });

  it('does not run an event again after it succeeded', async () => {
    const { handler, counter } = countingHandler();

    const first = await deliver(handler, 'evt_after_success');
    const resend = await deliver(handler, 'evt_after_success');

    expect(first).toMatchObject(ran);
    expect(resend).toMatchObject({ ...done, webhookId: first.webhookId });
    expect(counter.runs).toBe(1);
  });
});

describe('WebhookHandler: no lost events', () => {
  it('answers a failure as retryable, and the resend runs the event again', async () => {
    const { handler, counter } = countingHandler({}, failingOnce);

    expect(await deliver(handler, 'evt_fail_then_resend')).toMatchObject({ success: false, retryable: true });
    expect(await rowFor('evt_fail_then_resend')).toMatchObject({
      processed: false,
      errorMessage: 'downstream unavailable',
    });

    expect(await deliver(handler, 'evt_fail_then_resend')).toMatchObject(ran);
    expect(counter.runs).toBe(2);
    expect(await rowFor('evt_fail_then_resend')).toMatchObject({ processed: true, attempts: 2, errorMessage: null });
  });

  it('takes over an attempt that crashed (no error, older than the lease)', async () => {
    const { handler, counter } = countingHandler();
    await seedRow('evt_crashed', { lastAttemptAt: sub(now(), { minutes: 10 }) });

    expect(await deliver(handler, 'evt_crashed')).toMatchObject(ran);
    expect(counter.runs).toBe(1);
    expect(await rowFor('evt_crashed')).toMatchObject({ processed: true, attempts: 2 });
  });

  it('lets only one of two copies take over a failed event', async () => {
    const { handler, counter } = countingHandler({}, failingOnce);
    await deliver(handler, 'evt_fail_then_two');

    const results = await Promise.all([deliver(handler, 'evt_fail_then_two'), deliver(handler, 'evt_fail_then_two')]);

    expect(counter.runs).toBe(2);
    expect(results.filter((r) => r.success && r.error === undefined)).toHaveLength(1);
    expect(results.filter((r) => isBusyOrDone(r))).toHaveLength(1);
    expect(await rowFor('evt_fail_then_two')).toMatchObject({ processed: true, attempts: 2 });
  });

  it('the takeover query is won by exactly one of two callers that read the same row', async () => {
    const failed = await seedRow('evt_race', { lastAttemptAt: now(), errorMessage: 'boom' });
    // A cutoff in the future (a server clock running ahead) would let every
    // attempt be taken over; only the `attempts` check stops the second.
    const cutoff = add(now(), { minutes: 5 });

    const won = await Promise.all([
      reclaimWebhookEvent(db, webhookEvents, failed.id, failed.attempts, cutoff),
      reclaimWebhookEvent(db, webhookEvents, failed.id, failed.attempts, cutoff),
    ]);

    expect(won.toSorted()).toEqual([false, true]);
    expect(await rowFor('evt_race')).toMatchObject({ attempts: 2, errorMessage: null });
  });

  it('stops the resends once maxRetries attempts have failed', async () => {
    const { handler, counter } = countingHandler({ maxRetries: 3 }, () => Promise.reject(new Error('always')));

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await deliver(handler, 'evt_capped')).toMatchObject({ success: false, retryable: true });
    }
    expect(await deliver(handler, 'evt_capped')).toMatchObject({
      success: false,
      retryable: false,
      error: 'Max retry attempts exceeded',
    });
    expect(counter.runs).toBe(3);
  });
});

describe('WebhookHandler.retryFailedWebhooks', () => {
  it('re-runs a failed event, but never one still running', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { handler, counter } = countingHandler({}, async (run) => {
      if (run === 1) {
        throw new Error('downstream unavailable');
      }
      if (run === 2) {
        entered.resolve();
        await release.promise;
      }
    });

    await deliver(handler, 'evt_retry_job');
    expect(counter.runs).toBe(1);

    const retrying = handler.retryFailedWebhooks();
    await entered.promise;
    // The job's own attempt is now running: a second pass must not start it again.
    await handler.retryFailedWebhooks();
    expect(counter.runs).toBe(2);

    release.resolve();
    await retrying;
    expect(counter.runs).toBe(2);
    expect(await rowFor('evt_retry_job')).toMatchObject({ processed: true, attempts: 2 });
  });
});

describe('WebhookHandler before the claim', () => {
  it('acknowledges an event type it does not handle and stores nothing', async () => {
    const { handler, counter } = countingHandler({ result: { isValid: true, provider: 'stripe', data: {} } });

    const result = await deliver(handler, 'evt_unhandled');

    expect(result).toEqual({ success: true, error: 'Unhandled event type: customer.subscription.created' });
    expect(counter.runs).toBe(0);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it('rejects an event that fails validation, without asking for a resend, and stores nothing', async () => {
    const { handler, counter } = countingHandler({
      result: { isValid: false, provider: 'stripe', error: 'Invalid webhook signature' },
    });

    const result = await deliver(handler, 'evt_invalid');

    expect(result).toEqual({ success: false, error: 'Invalid webhook signature', retryable: false });
    expect(counter.runs).toBe(0);
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it('passes skipIpValidation to the validator, off unless asked for', async () => {
    const skipping = countingHandler({ skipIpValidation: true });
    const checking = countingHandler();

    await deliver(skipping.handler, 'evt_skip_ip');
    await deliver(checking.handler, 'evt_check_ip');

    expect(skipping.calls).toEqual([{ skipIpValidation: true }]);
    expect(checking.calls).toEqual([{ skipIpValidation: false }]);
  });
});
