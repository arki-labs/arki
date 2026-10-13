/**
 * StripeProvider: amounts in Stripe's units
 *
 * Stripe takes and sends integers in its own units, which are not always
 * cents: JPY has no minor unit, so 1500 JPY is `1500`, not `150000`. These
 * tests pin what goes over the wire and what comes back, with the Stripe
 * client replaced by a recorder (no network).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { money } from '@arki/money';
import { CurrencyMismatchError } from '@arki/money/errors';

import { createCustomerId, createPaymentId } from '../primitives';
import { StripeProvider } from './stripe-provider';

const sent = vi.hoisted(() => ({
  refunds: [] as { amount?: number }[],
  calculations: [] as { currency: string; line_items: { amount: number }[] }[],
}));

vi.mock('stripe', () => ({
  default: class {
    refunds = {
      create: (params: { amount?: number }) => {
        sent.refunds.push(params);

        return Promise.resolve({
          id: 're_test',
          // Without an amount Stripe refunds the whole charge and says how much
          amount: params.amount ?? 5000,
          currency: 'jpy',
          status: 'succeeded',
          metadata: {},
          created: 1_767_225_600,
        });
      },
    };

    tax = {
      calculations: {
        create: (params: { currency: string; line_items: { amount: number }[] }) => {
          sent.calculations.push(params);

          // Stripe answers in its units: 10% tax on 1500 JPY is 150 JPY
          return Promise.resolve({
            currency: params.currency,
            amount_total: 1650,
            tax_amount_exclusive: 150,
            tax_amount_inclusive: 0,
            line_items: {
              data: [
                {
                  tax_breakdown: [
                    {
                      amount: 150,
                      tax_rate_details: { percentage_decimal: '10.0' },
                      jurisdiction: { display_name: 'Japan', level: 'country' },
                    },
                  ],
                },
              ],
            },
          });
        },
      },
    };
  },
}));

const provider = new StripeProvider({ apiKey: 'sk_test_units', webhookSecret: 'whsec_units', environment: 'sandbox' });

beforeEach(() => {
  sent.refunds.length = 0;
  sent.calculations.length = 0;
});

describe('refundPayment', () => {
  it('sends a JPY refund in yen, and reads the answer back in yen: 1500 is 1500 JPY', async () => {
    const refund = await provider.refundPayment(createPaymentId(), { amount: money(1500, 'JPY') });

    expect(sent.refunds[0]?.amount).toBe(1500);
    expect(refund).toMatchObject({ amount: 1500, refundedAmount: 1500, currency: 'JPY' });
  });

  it('sends a USD refund in cents: 12.34 USD is 1234', async () => {
    await provider.refundPayment(createPaymentId(), { amount: money('12.34', 'USD') });

    expect(sent.refunds[0]?.amount).toBe(1234);
  });

  it('leaves the amount out for a whole refund, so Stripe refunds what was charged', async () => {
    await provider.refundPayment(createPaymentId(), {});

    expect(sent.refunds[0]?.amount).toBeUndefined();
  });
});

describe('calculateTax', () => {
  it('sends JPY line items in yen and reads totals back in yen', async () => {
    const result = await provider.calculateTax({
      customerId: createCustomerId(),
      currency: 'jpy',
      lineItems: [{ amount: money(1500, 'JPY'), reference: 'plan' }],
    });

    expect(sent.calculations[0]?.line_items[0]?.amount).toBe(1500);
    expect(result.amountTotal.toString()).toBe('1650 JPY');
    expect(result.taxAmountExclusive.toString()).toBe('150 JPY');
    expect(result.taxBreakdown[0]?.amount.toString()).toBe('150 JPY');
  });

  it('refuses a line item in another currency before calling Stripe', async () => {
    await expect(
      provider.calculateTax({
        customerId: createCustomerId(),
        currency: 'USD',
        lineItems: [{ amount: money(10, 'EUR'), reference: 'plan' }],
      }),
    ).rejects.toBeInstanceOf(CurrencyMismatchError);
    expect(sent.calculations).toHaveLength(0);
  });
});
