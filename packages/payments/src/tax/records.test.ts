/**
 * Customer tax summary: from stored per-jurisdiction tax records
 *
 * The summary used to answer zero dollars and no jurisdictions whatever the
 * customer paid. Now `createTaxTransaction` stores the tax of each jurisdiction
 * and the summary adds those up. Real repositories on PGlite; Stripe on a fake
 * HTTP layer.
 */
import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instant, now } from '@arki/date';
import { orThrow } from '@arki/failure';
import { money } from '@arki/money';

import type { Customer } from '../core/types.js';
import { createCustomerId } from '../core/primitives.js';
import { StripeProvider } from '../core/providers/stripe-provider.js';
import { createFakeStripeHttp } from '../core/providers/stripe-test-support.js';
import { customerId, openDb, schema } from '../test-support.js';
import { createTaxRepositories } from './repository.js';
import { TaxService } from './service.js';
import { createTaxTables } from './tables.js';

const tax = createTaxTables({ schema });
const otherCustomer = createCustomerId();

let client: PGlite;
let service: TaxService;
let requests: ReturnType<typeof createFakeStripeHttp>['requests'];

const buyer: Customer = {
  id: customerId,
  userId: 'usr_buyer',
  providerCustomerId: 'cus_test',
  provider: 'stripe',
  email: 'buyer@example.com',
  name: null,
  defaultPaymentMethodId: null,
  metadata: null,
  createdAt: now(),
  updatedAt: now(),
};

const lineItems = [{ amount: money('100', 'EUR'), description: 'Pro', reference: 'line_1' }];
const germany = { jurisdiction: 'Germany', rate: 19, amount: money('19', 'EUR') };
const berlin = { jurisdiction: 'Berlin', rate: 1, amount: money('1', 'EUR') };

beforeAll(async () => {
  const opened = await openDb({ ...tax.enums, taxJurisdictions: tax.taxJurisdictions, taxExemptions: tax.taxExemptions, taxRecords: tax.taxRecords });
  client = opened.client;
  // Stripe calculates, then records the calculation under the caller's reference (or reverses a sale)
  const http = createFakeStripeHttp(request =>
    request.path === '/v1/tax/calculations'
      ? { body: { id: 'taxcalc_1', object: 'tax.calculation', currency: 'eur' } }
      : {
          body: {
            id: `tax_txn_${request.form.reference}`,
            object: 'tax.transaction',
            currency: 'eur',
            line_items: {
              object: 'list',
              url: '/v1/x',
              has_more: false,
              data: [{ amount: 10_000, amount_tax: 1900, tax_behavior: 'exclusive' }],
            },
          },
        },
  );
  requests = http.requests;
  const provider = new StripeProvider(
    { apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' },
    {
      references: {
        findCustomerById: id => Promise.resolve({ ...buyer, id }),
        findPlanById: () => Promise.resolve(null),
        findSubscriptionById: () => Promise.resolve(null),
        findPaymentById: () => Promise.resolve(null),
      },
      httpClient: http.client,
      maxNetworkRetries: 0,
    },
  );
  service = new TaxService(provider, createTaxRepositories(drizzle({ client: opened.client }), tax));
});

afterAll(async () => {
  await client.close();
});

describe('getCustomerTaxSummary', () => {
  it('is empty, not invented, for a customer with no recorded tax', async () => {
    const summary = await service.getCustomerTaxSummary({ customerId: otherCustomer, year: 2030 });

    expect(summary).toEqual({ totalTaxPaid: [], totalTransactions: 0, breakdown: [] });
  });

  it('adds up what each jurisdiction collected, less what it gave back, per currency', async () => {
    await orThrow(service.createTaxTransaction({
      reference: 'pay_1',
      type: 'sale',
      customerId,
      lineItems,
      currency: 'EUR',
      breakdown: [germany, berlin],
      occurredAt: instant('2031-03-10T12:00:00Z'),
    }));
    await orThrow(service.createTaxTransaction({
      reference: 'pay_2',
      type: 'sale',
      customerId,
      lineItems,
      currency: 'EUR',
      breakdown: [germany, { ...germany, amount: money('4', 'EUR') }],
      occurredAt: instant('2031-11-02T12:00:00Z'),
    }));
    await orThrow(service.createTaxTransaction({
      reference: 'refund_1',
      type: 'refund',
      customerId,
      lineItems,
      currency: 'EUR',
      breakdown: [{ ...germany, amount: money('5', 'EUR') }],
      originalReference: 'pay_1',
      occurredAt: instant('2031-12-01T12:00:00Z'),
    }));
    expect(requests.at(-1)).toMatchObject({
      path: '/v1/tax/transactions/create_reversal',
      form: { original_transaction: 'tax_txn_pay_1', reference: 'refund_1' },
    });
    // Another year and another customer must not leak in
    await orThrow(service.createTaxTransaction({
      reference: 'pay_old',
      type: 'sale',
      customerId,
      lineItems,
      currency: 'EUR',
      breakdown: [germany],
      occurredAt: instant('2030-12-31T23:59:59Z'),
    }));
    await orThrow(service.createTaxTransaction({
      reference: 'pay_other',
      type: 'sale',
      customerId: otherCustomer,
      lineItems,
      currency: 'EUR',
      breakdown: [germany],
      occurredAt: instant('2031-03-10T12:00:00Z'),
    }));

    const summary = await service.getCustomerTaxSummary({ customerId, year: 2031 });

    expect(summary.totalTransactions).toBe(2);
    expect(summary.totalTaxPaid.map(total => total.toJSON())).toEqual([{ amount: '38.00', currency: 'EUR' }]);
    expect(summary.breakdown.map(line => [line.jurisdiction, line.taxAmount.toDecimalString(), line.transactionCount])).toEqual([
      ['Berlin', '1.00', 1],
      // pay_1 19, pay_2 19 + 4 (two lines, one rate), less the 5 refunded
      ['Germany', '37.00', 2],
    ]);
  });

  it('records a transaction once: the same reference again changes nothing and does not call the provider', async () => {
    const before = requests.length;
    const again = await orThrow(service.createTaxTransaction({
      reference: 'pay_1',
      type: 'sale',
      customerId,
      lineItems,
      currency: 'EUR',
      breakdown: [{ ...germany, amount: money('99', 'EUR') }],
      occurredAt: instant('2031-03-10T12:00:00Z'),
    }));

    expect(requests).toHaveLength(before);
    expect(again.taxAmount.toDecimalString()).toBe('20.00');
    expect(again.breakdown.map(line => line.jurisdiction)).toEqual(['Berlin', 'Germany']);
  });

  it('refuses a refund of a sale that was never recorded, so it cannot reverse a stranger', async () => {
    await expect(
      service.createTaxTransaction({
        reference: 'refund_x',
        type: 'refund',
        customerId,
        lineItems,
        currency: 'EUR',
        breakdown: [germany],
        originalReference: 'pay_unknown',
      }),
    ).rejects.toThrow(/never recorded/);
  });

  it('refuses tax in another currency than the transaction, so a wrong total is never stored', async () => {
    await expect(
      service.createTaxTransaction({
        reference: 'pay_mixed',
        type: 'sale',
        customerId,
        lineItems,
        currency: 'EUR',
        breakdown: [{ ...germany, amount: money('19', 'USD') }],
      }),
    ).rejects.toThrow(/USD/);
  });
});
