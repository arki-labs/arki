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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instant } from '@arki/date';
import { money } from '@arki/money';
import { CurrencyMismatchError } from '@arki/money/errors';

import type { AppDb } from '../../test-support.js';
import type { CoreWrites } from '../journal.js';
import type { PlanId } from '../primitives.js';
import { coreReads, runnerOn, seedSubscription } from '../../service-test-support.js';
import { core, openDb, typed } from '../../test-support.js';
import { createPlanId } from '../primitives.js';
import { ProrationService } from './proration-service.js';

let db: AppDb;
let client: PGlite;
let writes: CoreWrites;

/** The subscription runs 2026-01-01 → 2026-02-01 (31 days) on the 10.00 USD test plan; 21 days are left. */
const effectiveDate = instant('2026-01-11T00:00:00.000Z');

async function planAt(price: string, currency: string): Promise<PlanId> {
  const id = createPlanId();
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

    const { costs } = await new ProrationService(coreReads(db)).calculateProration(subscription.id, newPlanId, {
      prorationBehavior: 'create_prorations',
      effectiveDate,
    });

    expect(costs.newPlanProrated.toString()).toBe('677.41 USD');
    expect(costs.unusedCredit.toString()).toBe('6.77 USD');
    expect(costs.immediateCharge.toString()).toBe('670.64 USD');
    expect(costs.nextInvoiceTotal.toString()).toBe('999.99 USD');
  });

  it('splits a JPY price in whole yen: 21/31 of 1000 JPY is 677 JPY, never 6.77', async () => {
    const subscription = await seedSubscription(writes, 'active');
    const newPlanId = await planAt('1000', 'JPY');

    const { costs } = await new ProrationService(coreReads(db)).calculateProration(subscription.id, newPlanId, {
      prorationBehavior: 'always_invoice',
      effectiveDate,
    });

    expect(costs.immediateCharge.toString()).toBe('677 JPY');
  });

  it('refuses to credit a USD plan against a EUR plan instead of subtracting unlike amounts', async () => {
    const subscription = await seedSubscription(writes, 'active');
    const newPlanId = await planAt('10', 'EUR');

    await expect(
      new ProrationService(coreReads(db)).calculateProration(subscription.id, newPlanId, {
        prorationBehavior: 'create_prorations',
        effectiveDate,
      }),
    ).rejects.toBeInstanceOf(CurrencyMismatchError);
  });
});
