// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
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
import { FAILURE_ERROR_CODES, InvalidInput, orThrow } from '@arki/failure';
import { money } from '@arki/money';

import type { Customer } from '../core/types.js';
import { createCustomerId } from '../core/primitives.js';
import { ReferenceNotFound } from '../core/providers/provider-error.js';
import { StripeProvider } from '../core/providers/stripe-provider.js';
import { createFakeStripeHttp } from '../core/providers/stripe-test-support.js';
import { customerId, openDb, rejectionOf, schema } from '../test-support.js';
import { TaxCurrencyMismatch, TaxLineCurrencyMismatch, TaxRefundSaleNotFound } from './failures.js';
import { createTaxRepositories } from './repository.js';
import { taxCalculationInputSchema } from './contracts.js';
import { TaxService } from './service.js';
import { createTaxTables } from './tables.js';

const tax = createTaxTables({ schema });
const otherCustomer = orThrow(createCustomerId());

let client: PGlite;
let service: TaxService;
let repos: ReturnType<typeof createTaxRepositories>;
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
  repos = createTaxRepositories(drizzle({ client: opened.client }), tax);
  service = new TaxService(provider, repos);
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
    const refund = { reference: 'refund_x', type: 'refund' as const, customerId, lineItems, currency: 'EUR', breakdown: [germany] };

    const unknown = await service.createTaxTransaction({ ...refund, originalReference: 'pay_unknown' });
    expect(TaxRefundSaleNotFound.is(unknown) && unknown.data).toEqual({ reference: 'refund_x', originalReference: 'pay_unknown' });

    const unnamed = await service.createTaxTransaction(refund);
    expect(TaxRefundSaleNotFound.is(unnamed) && unnamed.data).toEqual({ reference: 'refund_x', originalReference: null });
  });

  it('refuses a sale for a customer the provider cannot find, and asks Stripe nothing', async () => {
    const http = createFakeStripeHttp(() => ({ body: {} }));
    const provider = new StripeProvider(
      { apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' },
      {
        references: {
          findCustomerById: () => Promise.resolve(null),
          findPlanById: () => Promise.resolve(null),
          findSubscriptionById: () => Promise.resolve(null),
          findPaymentById: () => Promise.resolve(null),
        },
        httpClient: http.client,
        maxNetworkRetries: 0,
      },
    );
    const strangers = new TaxService(provider, createTaxRepositories(drizzle({ client }), tax));

    const refused = await strangers.createTaxTransaction({
      reference: 'pay_stranger',
      type: 'sale',
      customerId: otherCustomer,
      lineItems,
      currency: 'EUR',
      breakdown: [germany],
    });

    expect(ReferenceNotFound.is(refused) && refused.data).toMatchObject({ kind: 'customer', id: otherCustomer });
    expect(http.requests).toEqual([]);
  });

  it('refuses tax in another currency than the transaction, so a wrong total is never stored', async () => {
    const before = requests.length;
    const refused = await service.createTaxTransaction({
      reference: 'pay_mixed',
      type: 'sale',
      customerId,
      lineItems,
      currency: 'EUR',
      breakdown: [{ ...germany, amount: money('19', 'USD') }],
    });

    expect(TaxCurrencyMismatch.is(refused) && refused.data).toEqual({
      reference: 'pay_mixed',
      jurisdiction: germany.jurisdiction,
      taxCurrency: 'USD',
      transactionCurrency: 'EUR',
    });
    expect(requests).toHaveLength(before);
  });
});

describe('a line item in another currency than the transaction', () => {
  // A USD line in a EUR sale used to throw CurrencyMismatchError from the sum, after the request schema had let it in
  it('is refused as payments.tax_line_currency_mismatch by calculateTax and createTaxTransaction, and Stripe is not asked', async () => {
    const before = requests.length;
    const mixed = [...lineItems, { amount: money('5', 'USD'), description: 'Add-on', reference: 'line_usd' }];
    const mismatch = { lineReference: 'line_usd', lineCurrency: 'USD', transactionCurrency: 'EUR' };

    const calculated = await service.calculateTax({ customerId, currency: 'EUR', lineItems: mixed });
    expect(TaxLineCurrencyMismatch.is(calculated) && calculated.data).toEqual(mismatch);

    const recorded = await service.createTaxTransaction({
      reference: 'pay_line_usd',
      type: 'sale',
      customerId,
      lineItems: mixed,
      currency: 'EUR',
      breakdown: [germany],
    });
    expect(TaxLineCurrencyMismatch.is(recorded) && recorded.data).toEqual(mismatch);
    expect(requests).toHaveLength(before);
    expect(await repos.records.findByReference('sale', 'pay_line_usd')).toEqual([]);
  });

  it('is refused by the request contract too', () => {
    const parsed = taxCalculationInputSchema.safeParse({
      customerId,
      currency: 'eur',
      lineItems: [{ amount: { amount: '5', currency: 'USD' }, description: 'Add-on', reference: 'line_usd' }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('a reference recorded earlier in another currency', () => {
  // The replay used to add the stored EUR records up as USD and throw CurrencyMismatchError
  it('returns payments.tax_currency_mismatch, and Stripe is not asked again', async () => {
    orThrow(await service.createTaxTransaction({
      reference: 'pay_eur_once',
      type: 'sale',
      customerId,
      lineItems,
      currency: 'EUR',
      breakdown: [germany],
      occurredAt: instant('2032-01-10T12:00:00Z'),
    }));
    const before = requests.length;

    const again = await service.createTaxTransaction({
      reference: 'pay_eur_once',
      type: 'sale',
      customerId,
      lineItems: [{ amount: money('100', 'USD'), description: 'Pro', reference: 'line_1' }],
      currency: 'USD',
      breakdown: [{ ...germany, amount: money('19', 'USD') }],
    });

    expect(TaxCurrencyMismatch.is(again) && again.data).toEqual({
      reference: 'pay_eur_once',
      jurisdiction: 'Germany',
      taxCurrency: 'EUR',
      transactionCurrency: 'USD',
    });
    expect(requests).toHaveLength(before);
  });
});

describe('a tax record a column cannot store', () => {
  // Stripe used to record the transaction before the local insert failed with a raw 22003, 22001, 23514 or 22021: the two then disagreed
  it('is refused as schema.invalid_input before Stripe is asked, and nothing is recorded', async () => {
    const before = requests.length;
    const sale = { type: 'sale' as const, customerId, lineItems, currency: 'EUR' };
    for (const [reference, breakdown] of [
      ['pay_rate', [{ ...germany, rate: 10_000 }]],
      ['pay_negative', [{ ...germany, amount: money('-1', 'EUR') }]],
      ['pay_nul_place', [{ ...germany, jurisdiction: 'Ger\u0000many' }]],
      ['pay_long_place', [{ ...germany, jurisdiction: 'x'.repeat(256) }]],
    ] as const) {
      const refused = await service.createTaxTransaction({ ...sale, reference, breakdown: [...breakdown] });
      expect(refused).toMatchObject({ code: InvalidInput.code });
      expect(await repos.records.findByReference('sale', reference)).toEqual([]);
    }
    const longReference = await service.createTaxTransaction({ ...sale, reference: 'r'.repeat(256), breakdown: [germany] });
    expect(longReference).toMatchObject({ code: InvalidInput.code });
    const farFuture = await service.createTaxTransaction({
      ...sale,
      reference: 'pay_far_future',
      breakdown: [germany],
      occurredAt: instant('+010000-01-01T00:00:00Z'),
    });
    expect(farFuture).toMatchObject({ code: InvalidInput.code });
    expect(requests).toHaveLength(before);
  });

  it('is refused by recordMany too, and no row of the batch is written', async () => {
    const row = { reference: 'direct_1', type: 'sale' as const, jurisdiction: 'Germany', rate: '19', taxAmountMinor: 1900, currency: 'EUR' };

    expect(await repos.records.recordMany([row, { ...row, jurisdiction: 'Berlin', rate: '10000' }])).toMatchObject({ code: InvalidInput.code });
    expect(await repos.records.recordMany([{ ...row, taxAmountMinor: -1 }])).toMatchObject({ code: InvalidInput.code });
    expect(await repos.records.findByReference('sale', 'direct_1')).toEqual([]);
  });
});

describe('a read asked for U+0000', () => {
  const nul = 'cus_\u0000';
  const year2031 = { start: instant('2031-01-01T00:00:00Z'), end: instant('2032-01-01T00:00:00Z') };

  // No record holds U+0000, so the answer is empty; Postgres used to refuse the parameter with a raw 22021
  it('finds no record', async () => {
    expect(await repos.records.findByReference('sale', nul)).toEqual([]);
    expect(await repos.records.countSaleTransactions({ ...year2031, customerId: nul })).toBe(0);
    expect(await repos.records.totalsByJurisdiction({ ...year2031, jurisdiction: nul })).toEqual([]);
    expect(await repos.records.totalsByPayment({ ...year2031, jurisdiction: nul })).toEqual([]);
  });

  // Postgres refuses a time past the year 9999 as a parameter (raw 22009); a typed Instant there is the caller's bug
  it('fails as an invariant for a time past the year 9999, before the query', async () => {
    const far = { start: instant('2031-01-01T00:00:00Z'), end: instant('+010000-01-01T00:00:00Z') };
    for (const read of [
      () => repos.records.countSaleTransactions(far),
      () => repos.records.totalsByJurisdiction(far),
      () => repos.records.totalsByPayment(far),
      () => repos.exemptions.findExemptionsInRange(far.start, far.end),
      () => repos.exemptions.findCustomerExemptionsInRange(customerId, far.start, far.end),
      () => repos.exemptions.findApplicableExemptions(customerId, far.end),
    ]) {
      expect(await rejectionOf(read())).toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
    }
  });
});

describe('getCustomerTaxSummary for a year the contract would refuse', () => {
  // `year` is typed as a number; NaN used to escape as `RangeError: instant() received an invalid Date`
  it('fails as an invariant before anything is read', async () => {
    const error = await rejectionOf(service.getCustomerTaxSummary({ customerId, year: Number.NaN }));

    expect(error).toMatchObject({ code: FAILURE_ERROR_CODES.invariant });
  });
});
