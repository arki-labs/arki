// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
/**
 * TaxReportingService.getCustomerTaxSummary: from stored payments, not placeholders
 *
 * The summary a customer hands to their accountant must hold what they paid and
 * the tax recorded at checkout, nothing invented. These tests run the real
 * repositories on PGlite: payments written through the journal commands, tax
 * read from each payment's metadata.
 */
import type { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instant } from '@arki/date';
import { orThrow } from '@arki/failure';
import { UnknownCurrency } from '@arki/money';

import type { PaymentId } from '../core/types.js';
import { createCustomerId } from '../core/primitives.js';
import { PaymentRepository } from '../core/repository.js';
import { runnerOn } from '../service-test-support.js';
import { adminId, core, customerId, openDb, schema, typed, userId } from '../test-support.js';
import { createTaxReportingService } from './reporting.js';
import { createTaxRepositories } from './repository.js';
import { createTaxTables } from './tables.js';

const tax = createTaxTables({ schema });

const relations = defineRelations(
  { plans: core.plans, customers: core.customers, subscriptions: core.subscriptions, payments: core.payments },
  r => ({
    subscriptions: {
      plan: r.one.plans({ from: r.subscriptions.planId, to: r.plans.id }),
      customer: r.one.customers({ from: r.subscriptions.customerId, to: r.customers.id }),
    },
    payments: {
      subscription: r.one.subscriptions({ from: r.payments.subscriptionId, to: r.subscriptions.id }),
      customer: r.one.customers({ from: r.payments.customerId, to: r.customers.id }),
    },
  }),
);

const thisYear = new Date().getUTCFullYear();
const otherCustomerId = orThrow(createCustomerId());

let client: PGlite;
let writes: ReturnType<typeof typed.core.writes>;
let reporting: ReturnType<typeof createTaxReportingService>;
let taxRepos: ReturnType<typeof createTaxRepositories>;
let paymentCounter = 0;

async function payment(options: {
  customer?: typeof customerId;
  amount: string;
  currency?: string;
  metadata?: Record<string, unknown>;
  settle?: 'succeeded' | 'failed' | 'pending';
  subscriptionId?: string;
  description?: string;
}): Promise<PaymentId> {
  paymentCounter += 1;
  const customer = options.customer ?? customerId;
  const created = await orThrow(
    writes.initiatePayment({
      userId: customer === customerId ? userId : adminId,
      customerId: customer,
      providerPaymentId: `pi_tax_${paymentCounter}`,
      amount: { amount: options.amount, currency: options.currency ?? 'USD' },
      description: options.description,
      metadata: options.metadata,
    }),
  );
  if (options.settle === undefined || options.settle === 'succeeded')
    await orThrow(writes.completePayment({ paymentId: created.id }));
  if (options.settle === 'failed')
    await orThrow(writes.failPayment({ paymentId: created.id, failureReason: 'declined' }));

  return created.id;
}

beforeAll(async () => {
  const opened = await openDb({
    ...tax.enums,
    taxJurisdictions: tax.taxJurisdictions,
    taxExemptions: tax.taxExemptions,
    taxConfigurations: tax.taxConfigurations,
    taxRecords: tax.taxRecords,
    taxAuditEntries: tax.taxAuditEntries,
  });
  client = opened.client;
  const db = opened.db;
  writes = typed.core.writes(runnerOn(db));

  await db
    .insert(core.customers)
    .values({ id: otherCustomerId, userId: adminId, providerCustomerId: 'cus_other', email: 'other@example.com' });

  const dbWithRelations = drizzle({ client, relations });
  taxRepos = createTaxRepositories(dbWithRelations, tax);
  reporting = createTaxReportingService({ payments: new PaymentRepository(dbWithRelations, core), ...taxRepos });

  const exemption = (customer: string, status: 'active' | 'revoked', validFrom: string, validTo: string | null) =>
    db.insert(tax.taxExemptions).values({
      type: 'customer',
      status,
      customerId: customer,
      exemptionCode: 'NONPROFIT',
      reason: 'Registered charity',
      certificateNumber: 'CERT-1',
      validFrom: instant(validFrom),
      validTo: validTo ? instant(validTo) : null,
    });
  await exemption(customerId, 'active', `${thisYear - 1}-06-01T00:00:00Z`, null);
  await exemption(customerId, 'revoked', `${thisYear - 1}-06-01T00:00:00Z`, null);
  await exemption(customerId, 'active', `${thisYear - 3}-01-01T00:00:00Z`, `${thisYear - 2}-01-01T00:00:00Z`);
  await exemption(otherCustomerId, 'active', `${thisYear - 1}-06-01T00:00:00Z`, null);
});

afterAll(async () => {
  await client.close();
});

describe('getCustomerTaxSummary', () => {
  it('says nothing was paid in a year with no payments, instead of inventing one', async () => {
    const summary = orThrow(await reporting.getCustomerTaxSummary(customerId, thisYear - 1));

    expect(summary.transactions).toEqual([]);
    expect(summary.totalPaid).toEqual([]);
    expect(summary.totalTax).toEqual([]);
  });

  it('sums what the customer paid and the tax recorded, one balance per currency', async () => {
    await payment({
      amount: '29.99',
      metadata: { taxAmount: { amount: '2.70', currency: 'USD' } },
      description: 'Pro Plan - Monthly',
    });
    await payment({ amount: '100', currency: 'EUR', description: 'Setup' });
    await payment({ amount: '10', settle: 'failed' });
    await payment({ amount: '15', settle: 'pending' });
    await payment({
      customer: otherCustomerId,
      amount: '999',
      metadata: { taxAmount: { amount: '99', currency: 'USD' } },
    });

    const summary = orThrow(await reporting.getCustomerTaxSummary(customerId, thisYear));

    expect(summary.customerId).toBe(customerId);
    expect(summary.transactions.map(t => [t.description, t.amount.toDecimalString(), t.tax.toDecimalString()])).toEqual(
      expect.arrayContaining([
        ['Pro Plan - Monthly', '29.99', '2.70'],
        ['Setup', '100.00', '0.00'],
      ]),
    );
    expect(summary.transactions).toHaveLength(2);
    expect(summary.transactions.every(t => t.type === 'one_time')).toBe(true);
    expect(summary.totalPaid.map(total => total.toJSON())).toEqual([
      { amount: '100.00', currency: 'EUR' },
      { amount: '29.99', currency: 'USD' },
    ]);
    expect(summary.totalTax.map(total => total.toJSON())).toEqual([
      { amount: '0.00', currency: 'EUR' },
      { amount: '2.70', currency: 'USD' },
    ]);
  });

  it('returns the money failure for a stored tax amount `@arki/money` refuses, never a wrong total', async () => {
    await payment({
      customer: otherCustomerId,
      amount: '20',
      metadata: { taxAmount: { amount: '2', currency: 'ZZZ' } },
    });

    expect(UnknownCurrency.is(await reporting.getCustomerTaxSummary(otherCustomerId, thisYear))).toBe(true);
  });

  it('lists the exemptions in force during the year: not revoked, not ended before it, not another customer’s', async () => {
    const summary = orThrow(await reporting.getCustomerTaxSummary(customerId, thisYear));

    expect(summary.exemptions).toHaveLength(1);
    expect(summary.exemptions[0]).toMatchObject({
      type: 'customer',
      reason: 'Registered charity',
      certificateNumber: 'CERT-1',
      validTo: null,
    });
  });

  it('refuses a payment whose recorded tax is not money, so a wrong total is never reported', async () => {
    const broken = await payment({
      customer: otherCustomerId,
      amount: '20',
      metadata: { taxAmount: 'about 2 dollars' },
    });

    await expect(reporting.getCustomerTaxSummary(otherCustomerId, thisYear)).rejects.toThrow(broken);
  });

  it('refuses recorded tax in another currency than the payment', async () => {
    const mismatched = await payment({
      customer: otherCustomerId,
      amount: '30',
      metadata: { taxAmount: { amount: '3', currency: 'EUR' } },
    });

    await expect(reporting.getCustomerTaxSummary(otherCustomerId, thisYear)).rejects.toThrow(/records tax in EUR/);
    expect(mismatched).toBeDefined();
  });
});
