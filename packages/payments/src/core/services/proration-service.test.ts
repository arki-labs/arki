// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.

/**
 * ProrationService: exact money for a plan change
 *
 * A plan change credits the time left on the old plan and charges the time
 * left on the new one. These tests pin that both shares come from the exact
 * time left, not from a percentage rounded to two decimals first; that a
 * zero-decimal currency is split in whole yen; and that plans in two
 * currencies are refused instead of mixed.
 */
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instant } from '@arki/date';
import { orThrow } from '@arki/failure';
import { money } from '@arki/money';

import type { AppDb } from '../../test-support.js';
import type { CoreWrites } from '../journal.js';
import type { PlanId } from '../primitives.js';
import { coreReads, runnerOn, seedSubscription } from '../../service-test-support.js';
import { core, customerId, openDb, planId, typed, userId } from '../../test-support.js';
import { EffectiveDateOutsidePeriod, PlanCurrencyMismatch, PlanInactive } from '../failures.js';
import { createPlanId, createSubscriptionId } from '../primitives.js';
import { ReferenceNotFound } from '../providers/provider-error.js';
import { ProrationService } from './proration-service.js';

let db: AppDb;
let client: PGlite;
let writes: CoreWrites;

/** The subscription runs 2026-01-01 → 2026-02-01 (31 days) on the 10.00 USD test plan; 21 days are left. */
const effectiveDate = instant('2026-01-11T00:00:00.000Z');

async function planAt(price: string, currency: string): Promise<PlanId> {
  const id = orThrow(createPlanId());
  const priceMinor = money(price, currency).toMinorNumber();
  await db.insert(core.plans).values({ id, name: `Plan ${price} ${currency}`, priceMinor, currency });

  return id;
}

beforeAll(async () => {
  ({ db, client } = await openDb());
  writes = typed.core.writes(runnerOn(db));
});

afterAll(async () => {
  await client.close();
});

describe('calculateProration', () => {
  it('charges the exact 21/31 of 999.99 USD (677.41), not 67.74% of it (677.39)', async () => {
    const subscription = await seedSubscription(writes, 'active');
    const newPlanId = await planAt('999.99', 'USD');

    const { costs } = await orThrow(
      new ProrationService(coreReads(db)).calculateProration(subscription.id, newPlanId, {
        prorationBehavior: 'create_prorations',
        effectiveDate,
      }),
    );

    expect(costs.newPlanProrated.toString()).toBe('677.41 USD');
    expect(costs.unusedCredit.toString()).toBe('6.77 USD');
    expect(costs.immediateCharge.toString()).toBe('670.64 USD');
    expect(costs.nextInvoiceTotal.toString()).toBe('999.99 USD');
  });

  it('splits a JPY price in whole yen: 21/31 of 1000 JPY is 677 JPY, never 6.77', async () => {
    const yenPlanId = await planAt('500', 'JPY');
    const subscription = await orThrow(
      writes.createSubscription({
        subscriptionId: orThrow(createSubscriptionId()),
        userId,
        planId: yenPlanId,
        customerId,
        providerSubscriptionId: 'psub_proration_jpy',
        status: 'active',
        currentPeriodStart: instant('2026-01-01T00:00:00.000Z'),
        currentPeriodEnd: instant('2026-02-01T00:00:00.000Z'),
      }),
    );
    const newPlanId = await planAt('1000', 'JPY');

    const { costs } = await orThrow(
      new ProrationService(coreReads(db)).calculateProration(subscription.id, newPlanId, {
        prorationBehavior: 'always_invoice',
        effectiveDate,
      }),
    );

    expect(costs.immediateCharge.toString()).toBe('677 JPY');
  });

  // A credit in one currency set against a charge in another would be a wrong amount, whatever the behaviour
  it.each(['create_prorations', 'none', 'always_invoice'] as const)(
    'returns PlanCurrencyMismatch for a USD plan moved to a EUR plan (%s)',
    async prorationBehavior => {
      const subscription = await seedSubscription(writes, 'active');
      const newPlanId = await planAt('10', 'EUR');

      const result = await new ProrationService(coreReads(db)).calculateProration(subscription.id, newPlanId, {
        prorationBehavior,
        effectiveDate,
      });

      expect(PlanCurrencyMismatch.is(result)).toBe(true);
      expect(result).toMatchObject({
        code: 'payments.plan_currency_mismatch',
        data: { currentPlanId: planId, newPlanId, currentCurrency: 'USD', newCurrency: 'EUR' },
      });
    },
  );

  // A stored period with no length has nothing to split: `allocate` refused the zero weights with a raw throw
  it('returns EffectiveDateOutsidePeriod for a stored period that starts and ends at the same instant', async () => {
    const at = instant('2026-01-01T00:00:00.000Z');
    const subscription = await orThrow(
      writes.createSubscription({
        subscriptionId: orThrow(createSubscriptionId()),
        userId,
        planId,
        customerId,
        providerSubscriptionId: 'psub_proration_empty_period',
        status: 'active',
        currentPeriodStart: at,
        currentPeriodEnd: at,
      }),
    );
    const newPlanId = await planAt('20', 'USD');

    const result = await new ProrationService(coreReads(db)).calculateProration(subscription.id, newPlanId, {
      prorationBehavior: 'create_prorations',
      effectiveDate: at,
    });

    expect(EffectiveDateOutsidePeriod.is(result)).toBe(true);
  });

  it.each([
    ['before the period starts', '2025-12-31T23:59:59.000Z'],
    ['after the period ends', '2026-02-01T00:00:01.000Z'],
  ])('returns EffectiveDateOutsidePeriod for an effective date %s', async (_when, at) => {
    const subscription = await seedSubscription(writes, 'active');
    const newPlanId = await planAt('20', 'USD');

    const result = await new ProrationService(coreReads(db)).calculateProration(subscription.id, newPlanId, {
      prorationBehavior: 'create_prorations',
      effectiveDate: instant(at),
    });

    expect(EffectiveDateOutsidePeriod.is(result)).toBe(true);
    expect(result).toMatchObject({
      code: 'payments.effective_date_outside_period',
      data: { subscriptionId: subscription.id },
    });
  });

  it('returns ReferenceNotFound for an unknown subscription or plan, and PlanInactive for a retired plan', async () => {
    const service = new ProrationService(coreReads(db));
    const subscription = await seedSubscription(writes, 'active');
    const unknownPlan = orThrow(createPlanId());
    const unknownSubscription = orThrow(createSubscriptionId());
    const retired = await planAt('20', 'USD');
    await db.update(core.plans).set({ isActive: false }).where(eq(core.plans.id, retired));
    const options = { prorationBehavior: 'create_prorations', effectiveDate } as const;

    expect(await service.calculateProration(unknownSubscription, planId, options)).toMatchObject({
      code: 'payments.reference_not_found',
      data: { kind: 'subscription', id: unknownSubscription, missing: 'row' },
    });
    expect(ReferenceNotFound.is(await service.calculateProration(subscription.id, unknownPlan, options))).toBe(true);
    expect(PlanInactive.is(await service.calculateProration(subscription.id, retired, options))).toBe(true);
  });
});

describe('the callers of calculateProration hand its failure back', () => {
  it('previewSubscriptionChange, getOptimalChangeTimings and generateProrationSummary return PlanCurrencyMismatch', async () => {
    const service = new ProrationService(coreReads(db));
    const subscription = await seedSubscription(writes, 'active');
    const euroPlan = await planAt('10', 'EUR');

    expect(PlanCurrencyMismatch.is(await service.previewSubscriptionChange(subscription.id, euroPlan))).toBe(true);
    expect(PlanCurrencyMismatch.is(await service.getOptimalChangeTimings(subscription.id, euroPlan))).toBe(true);
    expect(
      PlanCurrencyMismatch.is(
        await service.generateProrationSummary(subscription.id, euroPlan, { prorationBehavior: 'none', effectiveDate }),
      ),
    ).toBe(true);
  });

  it('previewMultiplePlanChanges leaves out a plan it cannot preview and keeps the others', async () => {
    const service = new ProrationService(coreReads(db));
    const subscription = await seedSubscription(writes, 'active');
    const euroPlan = await planAt('10', 'EUR');
    const dollarPlan = await planAt('20', 'USD');

    const previews = await service.previewMultiplePlanChanges(subscription.id, [euroPlan, dollarPlan], {
      prorationBehavior: 'create_prorations',
      effectiveDate,
    });

    expect(Object.keys(previews)).toEqual([dollarPlan]);
  });
});
