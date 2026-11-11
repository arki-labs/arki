// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
/**
 * DunningService on the journal
 *
 * Flow: DunningService → writes(run) → command → journal event →
 *       `subscriptions` row, in one transaction.
 *
 * Dunning is what happens after a payment fails: mark the subscription past
 * due, retry, pause, and in the end cancel. Each step changes what the customer
 * can use, so each step must leave an event. The schedule of steps stays in
 * memory, as before; only the table writes moved. A canceled subscription is
 * never brought back by a recovery: the command refuses it.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isInstant } from '@arki/date';
import { isFailure, orThrow } from '@arki/failure';
import { CommandConflict } from '@arki/journal';

import type { AppDb } from '../../test-support.js';
import type { CoreWrites } from '../journal.js';
import type { Payment, PaymentStatus } from '../types.js';
import type { DunningEmail, DunningRule, DunningSenders, DunningWebhookCall } from './dunning-service.js';
import {
  coreReads,
  runnerOn,
  seedPayment,
  seedSubscription,
  subscriptionRow,
  unexpectedCall,
} from '../../service-test-support.js';
import { countEvents, eventTypesOf, openDb, typed, userId } from '../../test-support.js';
import { MAX_BATCH_ITEMS } from '../pg-values.js';
import { createPaymentId, createSubscriptionId } from '../primitives.js';
import { CardDeclined, ReferenceNotFound } from '../providers/provider-error.js';
import { DunningService } from './dunning-service.js';

type Provider = Parameters<typeof DunningService.create>[0];

let db: AppDb;
let client: PGlite;
let reads: ReturnType<typeof coreReads>;
let writes: CoreWrites;

/** One rule that runs at once when a payment fails. */
function ruleDoing(type: DunningRule['action']['type']): DunningRule {
  return {
    id: `test_${type}`,
    name: `Test ${type}`,
    enabled: true,
    trigger: { event: 'payment_failed', delayDays: 0 },
    action: { type, config: type === 'email' ? { template: 'payment_failed_template' } : {} },
  };
}

/** What the app's mailer and webhook client were handed, in order. */
const sentEmails: DunningEmail[] = [];
const webhookCalls: DunningWebhookCall[] = [];

/** The app's senders: they deliver by recording what they were handed. */
const senders: DunningSenders = {
  async sendEmail(email) {
    sentEmails.push(email);
  },
  async sendWebhook(call) {
    webhookCalls.push(call);
  },
};

/** The code of a returned failure, or nothing for a value that is not one. */
function failureCode(result: unknown): string | undefined {
  return isFailure(result) ? result.code : undefined;
}

/** A service built from a configuration that is valid. */
function build(...args: Parameters<typeof DunningService.create>) {
  return orThrow(DunningService.create(...args));
}

/** A provider where a retried payment ends in `retryStatus`, and pause and cancel go through. */
function providerWhereRetryEnds(retryStatus: PaymentStatus): Provider {
  const subscriptionAnswer = async (subscriptionId: Parameters<Provider['pauseSubscription']>[0]) => {
    const current = await reads.findSubscriptionById(subscriptionId);

    if (!current) {
      throw new Error(`the provider does not know ${subscriptionId}`);
    }

    return current;
  };

  return {
    async confirmPayment(paymentId): Promise<Payment> {
      const payment = await reads.findPaymentById(paymentId);

      if (!payment) {
        throw new Error(`the provider does not know ${paymentId}`);
      }

      return { ...payment, status: retryStatus };
    },
    pauseSubscription: subscriptionAnswer,
    cancelSubscription: subscriptionAnswer,
  };
}

function dunningWith(rule: DunningRule, retryStatus: PaymentStatus = 'succeeded') {
  return build(providerWhereRetryEnds(retryStatus), reads, writes, { rules: [rule] }, senders);
}

/** A subscription whose payment just failed, with dunning started. */
async function failedPaymentOn(service: DunningService) {
  const subscription = await seedSubscription(writes, 'active');
  const payment = await seedPayment(writes, subscription.id);
  await orThrow(service.handlePaymentFailure(payment.id, subscription.id, 'card_declined'));

  return subscription.id;
}

beforeAll(async () => {
  ({ db, client } = await openDb());
  reads = coreReads(db);
  writes = typed.core.writes(runnerOn(db));
});

afterAll(async () => {
  await client.close();
});

describe('handlePaymentFailure', () => {
  it('marks the subscription past due, records the event and schedules the steps', async () => {
    const service = dunningWith(ruleDoing('email'));

    const id = await failedPaymentOn(service);

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'past_due' });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual(['SubscriptionCreated', 'SubscriptionPastDue']);
    expect(service.getPendingEventsForSubscription(id)).toHaveLength(1);
  });

  it('a second failed payment on a subscription that is already past due writes no second event', async () => {
    const service = dunningWith(ruleDoing('email'));
    const id = await failedPaymentOn(service);
    const secondPayment = await seedPayment(writes, id);
    const eventsBefore = await eventTypesOf(db, 'subscription', id);

    await orThrow(service.handlePaymentFailure(secondPayment.id, id, 'card_declined'));

    expect(await eventTypesOf(db, 'subscription', id)).toEqual(eventsBefore);
  });

  it('an unknown payment starts nothing: it returns ReferenceNotFound and writes no event', async () => {
    const service = dunningWith(ruleDoing('email'));
    const { id } = await seedSubscription(writes, 'active');
    const paymentId = orThrow(createPaymentId());
    const eventsBefore = await countEvents(db);

    const result = await service.handlePaymentFailure(paymentId, id);

    expect(ReferenceNotFound.is(result)).toBe(true);
    expect(result).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'payment', id: paymentId, missing: 'row' },
    });
    expect(service.getPendingEventsForSubscription(id)).toEqual([]);
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'active' });
  });

  it('an unknown subscription starts nothing: it returns ReferenceNotFound and writes no event', async () => {
    const service = dunningWith(ruleDoing('email'));
    const { id } = await seedSubscription(writes, 'active');
    const payment = await seedPayment(writes, id);
    const unknown = orThrow(createSubscriptionId());
    const eventsBefore = await countEvents(db);

    const result = await service.handlePaymentFailure(payment.id, unknown);

    expect(result).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'subscription', id: unknown, missing: 'row' },
    });
    expect(service.getPendingEventsForSubscription(unknown)).toEqual([]);
    expect(await countEvents(db)).toBe(eventsBefore);
  });
});

describe('handlePaymentFailure on a subscription the journal will not mark past due', () => {
  it('returns the journal refusal and schedules no step, so nothing later retries or cancels a canceled subscription', async () => {
    const service = dunningWith(ruleDoing('cancel_subscription'));
    const subscription = await seedSubscription(writes, 'canceled');
    const payment = await seedPayment(writes, subscription.id);

    const result = await service.handlePaymentFailure(payment.id, subscription.id, 'card_declined');

    expect(result).toMatchObject({ code: 'journal.conflict' });
    expect(service.getPendingEventsForSubscription(subscription.id)).toEqual([]);
  });
});

describe('processDunningEvents', () => {
  it('a retry that succeeds makes the subscription active again and clears the remaining steps', async () => {
    const service = dunningWith(ruleDoing('retry_payment'), 'succeeded');
    const id = await failedPaymentOn(service);

    await service.processDunningEvents();

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'active' });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual([
      'SubscriptionCreated',
      'SubscriptionPastDue',
      'SubscriptionActivated',
    ]);
    expect(service.getPendingEventsForSubscription(id)).toHaveLength(0);
  });

  it('a retry that fails again changes nothing: the subscription stays past due and no event is written', async () => {
    const service = dunningWith(ruleDoing('retry_payment'), 'failed');
    const id = await failedPaymentOn(service);
    const eventsBefore = await countEvents(db);

    await service.processDunningEvents();

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'past_due' });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('the pause step pauses the subscription and records the event', async () => {
    const service = dunningWith(ruleDoing('pause_subscription'));
    const id = await failedPaymentOn(service);

    await service.processDunningEvents();

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'paused' });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual([
      'SubscriptionCreated',
      'SubscriptionPastDue',
      'SubscriptionPaused',
    ]);
  });

  /** The row follows the provider: when the provider says no, the subscription must not read paused or canceled. */
  it.each(['pause_subscription', 'cancel_subscription'] as const)(
    'a %s step the provider refuses leaves the subscription past due and writes no event',
    async step => {
      const refusing = (subscriptionId: string) =>
        Promise.resolve(ReferenceNotFound({ kind: 'subscription', id: subscriptionId, missing: 'row' }));
      const service = build(
        { ...providerWhereRetryEnds('succeeded'), pauseSubscription: refusing, cancelSubscription: refusing },
        reads,
        writes,
        { rules: [ruleDoing(step)] },
      );
      const id = await failedPaymentOn(service);
      const eventsBefore = await countEvents(db);

      await service.processDunningEvents();

      expect(await subscriptionRow(db, id)).toMatchObject({ status: 'past_due' });
      expect(await countEvents(db)).toBe(eventsBefore);
    },
  );

  it('a retry the card declines changes nothing: the subscription stays past due and no event is written', async () => {
    const service = build(
      { ...providerWhereRetryEnds('succeeded'), confirmPayment: () => Promise.resolve(CardDeclined({})) },
      reads,
      writes,
      { rules: [ruleDoing('retry_payment')] },
    );
    const id = await failedPaymentOn(service);
    const eventsBefore = await countEvents(db);

    await service.processDunningEvents();

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'past_due' });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('the cancel step ends the subscription with a cancellation time and records the event', async () => {
    const service = dunningWith(ruleDoing('cancel_subscription'));
    const id = await failedPaymentOn(service);

    await service.processDunningEvents();

    const row = await subscriptionRow(db, id);
    expect(row).toMatchObject({ status: 'canceled' });
    expect(isInstant(row?.canceledAt)).toBe(true);
    expect(await eventTypesOf(db, 'subscription', id)).toEqual([
      'SubscriptionCreated',
      'SubscriptionPastDue',
      'SubscriptionCanceled',
    ]);
  });
});

describe('a refused dunning step is reported to the caller, not only logged', () => {
  it('a pause the provider refuses comes back as refused with its failure, and the row stays past due', async () => {
    const unknownToProvider = ReferenceNotFound({ kind: 'subscription', id: 'sub_gone', missing: 'provider_id' });
    const service = build(
      { ...providerWhereRetryEnds('succeeded'), pauseSubscription: () => Promise.resolve(unknownToProvider) },
      reads,
      writes,
      { rules: [ruleDoing('pause_subscription')] },
    );
    const id = await failedPaymentOn(service);

    const reports = await service.processDunningEvents();

    // The app must learn that the subscription is still past due with no next step
    expect(reports).toMatchObject([{ status: 'refused', failure: { code: 'payments.reference_not_found' } }]);
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'past_due' });
  });

  it('a retry the card declines and a recovered payment on a canceled subscription are both reported', async () => {
    const declined = build(
      { ...providerWhereRetryEnds('succeeded'), confirmPayment: () => Promise.resolve(CardDeclined({})) },
      reads,
      writes,
      { rules: [ruleDoing('retry_payment')] },
    );
    await failedPaymentOn(declined);
    expect(await declined.processDunningEvents()).toMatchObject([
      { status: 'refused', failure: { code: 'payments.card_declined' } },
    ]);

    const recovered = dunningWith(ruleDoing('retry_payment'));
    const id = await failedPaymentOn(recovered);
    await orThrow(writes.cancelSubscription({ subscriptionId: id }));
    expect(await recovered.processDunningEvents()).toMatchObject([
      { status: 'refused', failure: { code: 'journal.conflict' } },
    ]);
  });

  it('a step that ran is reported done', async () => {
    const service = dunningWith(ruleDoing('pause_subscription'));
    await failedPaymentOn(service);

    expect(await service.processDunningEvents()).toMatchObject([{ status: 'done' }]);
  });
});

describe('a dunning step that throws', () => {
  it('stays scheduled for the next run instead of counting as done', async () => {
    const outage = new Error('provider is down');
    const service = build(
      { ...providerWhereRetryEnds('succeeded'), pauseSubscription: () => Promise.reject(outage) },
      reads,
      writes,
      { rules: [ruleDoing('pause_subscription')] },
    );
    const subscriptionId = await failedPaymentOn(service);

    await service.processDunningEvents();

    expect(service.getPendingEventsForSubscription(subscriptionId)).toHaveLength(1);
    expect(await subscriptionRow(db, subscriptionId)).toMatchObject({ status: 'past_due' });
  });
});

describe('handleSubscriptionRecovery', () => {
  it('a past due subscription whose payment went through is active again, with the event', async () => {
    const service = dunningWith(ruleDoing('email'));
    const id = await failedPaymentOn(service);

    await orThrow(service.handleSubscriptionRecovery(id));

    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'active' });
    expect(await eventTypesOf(db, 'subscription', id)).toEqual([
      'SubscriptionCreated',
      'SubscriptionPastDue',
      'SubscriptionActivated',
    ]);
    // The scheduled steps are gone. What is left is the in-memory note that the subscription recovered.
    expect(service.getPendingEventsForSubscription(id).map(event => event.eventType)).toEqual([
      'subscription_recovered',
    ]);
  });

  it('the recovery note names the user who owns the subscription', async () => {
    const service = dunningWith(ruleDoing('email'));
    const id = await failedPaymentOn(service);

    await orThrow(service.handleSubscriptionRecovery(id));

    expect(service.getPendingEventsForSubscription(id)).toEqual([
      expect.objectContaining({ eventType: 'subscription_recovered', userId }),
    ]);
  });

  it('a subscription that is already active writes no event', async () => {
    const service = dunningWith(ruleDoing('email'));
    const { id } = await seedSubscription(writes, 'active');
    const eventsBefore = await countEvents(db);

    await orThrow(service.handleSubscriptionRecovery(id));

    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('an id longer than the id column holds is schema.invalid_input, not a package bug', async () => {
    const service = dunningWith(ruleDoing('email'));
    const eventsBefore = await countEvents(db);

    // A valid id plus 255 characters: the stream name it becomes cannot be stored
    const refused = await service.handleSubscriptionRecovery(`${orThrow(createSubscriptionId())}${'q'.repeat(255)}`);

    expect(refused).toMatchObject({ code: 'schema.invalid_input' });
    expect(await countEvents(db)).toBe(eventsBefore);
  });

  it('an unknown subscription returns the journal not-found refusal', async () => {
    const service = dunningWith(ruleDoing('email'));

    const refused = await service.handleSubscriptionRecovery(orThrow(createSubscriptionId()));

    expect(refused).toMatchObject({ code: 'journal.not_found' });
  });

  it('a canceled subscription is not brought back by a late payment: the command refuses and the row stays canceled', async () => {
    const service = dunningWith(ruleDoing('email'));
    const { id } = await seedSubscription(writes, 'canceled');
    const eventsBefore = await countEvents(db);

    const refused = await service.handleSubscriptionRecovery(id);

    expect(CommandConflict.is(refused)).toBe(true);
    expect(refused).toMatchObject({ message: `Cannot activate canceled subscription ${id}` });
    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'canceled' });
  });
});

describe('what dunning does not own', () => {
  it('the provider is only asked for what the configured step needs', async () => {
    const provider: Provider = {
      confirmPayment: unexpectedCall('confirmPayment'),
      pauseSubscription: unexpectedCall('pauseSubscription'),
      cancelSubscription: unexpectedCall('cancelSubscription'),
    };
    const service = build(provider, reads, writes, { rules: [ruleDoing('email')] }, senders);
    const id = await failedPaymentOn(service);
    const eventsBefore = await countEvents(db);

    await service.processDunningEvents();

    expect(await countEvents(db)).toBe(eventsBefore);
    expect(await subscriptionRow(db, id)).toMatchObject({ status: 'past_due' });
  });
});

describe('steps the app delivers', () => {
  it('an email step sends its template to the customer address through sendEmail', async () => {
    const service = dunningWith(ruleDoing('email'));
    const subscriptionId = await failedPaymentOn(service);
    sentEmails.length = 0;

    await service.processDunningEvents();

    expect(sentEmails).toEqual([
      expect.objectContaining({
        to: 'buyer@example.com',
        template: 'payment_failed_template',
        subscriptionId,
        userId,
      }),
    ]);
    expect(service.getPendingEventsForSubscription(subscriptionId)).toHaveLength(0);
  });

  it('a webhook step hands the step config and its subscription to sendWebhook', async () => {
    const rule = ruleDoing('webhook');
    const service = dunningWith({ ...rule, action: { type: 'webhook', config: { endpoint: 'billing-events' } } });
    const subscriptionId = await failedPaymentOn(service);
    webhookCalls.length = 0;

    await service.processDunningEvents();

    expect(webhookCalls).toEqual([
      expect.objectContaining({ subscriptionId, userId, config: { endpoint: 'billing-events' } }),
    ]);
  });
});

describe('a step that needs a sender the app did not pass fails at boot', () => {
  const provider = () => providerWhereRetryEnds('succeeded');

  it('an email rule without sendEmail, the default rules without senders, or a webhook rule without sendWebhook', () => {
    expect(failureCode(DunningService.create(provider(), reads, writes, { rules: [ruleDoing('email')] }))).toBe(
      'payments.configuration_invalid',
    );
    expect(failureCode(DunningService.create(provider(), reads, writes))).toBe('payments.configuration_invalid');
    expect(
      failureCode(DunningService.create(provider(), reads, writes, { rules: [ruleDoing('webhook')] }, { sendEmail: senders.sendEmail }),
      ),
    ).toBe('payments.configuration_invalid');
  });

  it('an email rule with no template name', () => {
    const noTemplate: DunningRule = { ...ruleDoing('email'), action: { type: 'email', config: {} } };

    expect(failureCode(DunningService.create(provider(), reads, writes, { rules: [noTemplate] }, senders))).toBe(
      'payments.configuration_invalid',
    );
  });

  it.each([Number.NaN, 1.5, -1, 3651])(
    'a rule delayed by %s days (no real scheduled date) fails at boot and in updateConfiguration, keeping the old rules',
    delayDays => {
      const late: DunningRule = { ...ruleDoing('pause_subscription'), trigger: { event: 'payment_failed', delayDays } };
      // A disabled rule is checked too: enabling it later must not be what breaks the schedule
      const disabled: DunningRule = { ...late, enabled: false };

      expect(failureCode(DunningService.create(provider(), reads, writes, { rules: [late] }))).toBe(
        'payments.configuration_invalid',
      );
      expect(failureCode(DunningService.create(provider(), reads, writes, { rules: [disabled] }))).toBe(
        'payments.configuration_invalid',
      );
      const service = build(provider(), reads, writes, { rules: [ruleDoing('pause_subscription')] });
      expect(failureCode(service.updateConfiguration({ rules: [late] }))).toBe('payments.configuration_invalid');
      expect(service.getConfiguration().rules.map(rule => rule.trigger.delayDays)).toEqual([0]);
    },
  );

  it('more than MAX_BATCH_ITEMS rules or retry days are payments.configuration_invalid, at boot and in updateConfiguration', () => {
    const rules = Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => ruleDoing('pause_subscription'));
    const retrySchedule = Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => 1);

    expect(failureCode(DunningService.create(provider(), reads, writes, { rules }))).toBe('payments.configuration_invalid');
    expect(failureCode(DunningService.create(provider(), reads, writes, { rules: [], retrySchedule }))).toBe(
      'payments.configuration_invalid',
    );
    const service = build(provider(), reads, writes, { rules: [ruleDoing('pause_subscription')] });
    expect(failureCode(service.updateConfiguration({ retrySchedule }))).toBe('payments.configuration_invalid');
    expect(service.getConfiguration().retrySchedule).not.toHaveLength(MAX_BATCH_ITEMS + 1);
  });

  it('updateConfiguration refuses a rule it has no sender for and keeps the old rules', () => {
    const service = build(provider(), reads, writes, { rules: [ruleDoing('pause_subscription')] });

    expect(failureCode(service.updateConfiguration({ rules: [ruleDoing('email')] }))).toBe(
      'payments.configuration_invalid',
    );
    expect(service.getConfiguration().rules.map(rule => rule.action.type)).toEqual(['pause_subscription']);
  });
});

describe('getDunningStats', () => {
  it('reports only what the stored payments and subscriptions hold: no recovery time and no recovered revenue', async () => {
    const service = dunningWith(ruleDoing('email'));

    const stats = await service.getDunningStats();

    expect(Object.keys(stats).toSorted()).toEqual([
      'recoveredPayments',
      'recoveryRate',
      'revenueAtRisk',
      'subscriptionsInDunning',
      'totalFailedPayments',
    ]);
  });
});

describe('a cancel step sends the reason its config names', () => {
  it.each([
    [{ reason: 'fraud_review' }, 'fraud_review'],
    [{ reason: 42 }, 'payment_failure'],
    [{ reason: '' }, 'payment_failure'],
    [{}, 'payment_failure'],
  ] as const)('config %j cancels with reason %s', async (config, expected) => {
    const reasons: (string | undefined)[] = [];
    const base = providerWhereRetryEnds('succeeded');
    const provider: Provider = {
      ...base,
      async cancelSubscription(subscriptionId, options) {
        reasons.push(options.reason);
        return base.cancelSubscription(subscriptionId, options);
      },
    };
    const rule: DunningRule = { ...ruleDoing('cancel_subscription'), action: { type: 'cancel_subscription', config } };
    const service = build(provider, reads, writes, { rules: [rule] }, senders);

    await failedPaymentOn(service);
    await service.processDunningEvents();

    expect(reasons).toEqual([expected]);
  });
});
