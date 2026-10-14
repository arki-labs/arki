/**
 * Tax responses on the wire
 *
 * The tax services answer with `Money`, and JSON turns a `Money` into
 * `{ amount, currency }`. The response schemas say that wire shape, so the RPC
 * client's type is what actually arrives. These tests pin that the `*Json`
 * functions produce exactly what the schemas accept, with amounts kept exact
 * in their own currency, and that a raw `Money` is refused: a handler that
 * forgets the conversion fails on the server, not as a wrong type on a client.
 */
import { describe, expect, it } from 'vitest';

import { instant } from '@arki/date';
import { money } from '@arki/money';

import type { TaxComplianceReport } from './reporting.js';
import type { TaxCalculationResult } from './service.js';
import {
  customerTaxSummaryJson,
  customerTaxSummarySchema,
  taxCalculationResultJson,
  taxCalculationResultSchema,
  taxComplianceReportJson,
  taxComplianceReportSchema,
} from './contracts.js';

const calculation: TaxCalculationResult = {
  subtotal: money('1500', 'JPY'),
  taxAmount: money('150', 'JPY'),
  total: money('1650', 'JPY'),
  taxInclusive: false,
  breakdown: [{ jurisdiction: 'JP', rate: 10, amount: money('150', 'JPY') }],
  applicableTaxIds: [],
  appliedExemptionIds: [],
};

describe('taxCalculationResultSchema', () => {
  it('accepts the converted result, and it is what JSON makes of the Money values', () => {
    const sent = taxCalculationResultSchema.parse(taxCalculationResultJson(calculation));

    expect(JSON.stringify(sent)).toBe(JSON.stringify(calculation));
    expect(sent.total).toEqual({ amount: '1650', currency: 'JPY' });
    expect(sent.breakdown[0]?.amount).toEqual({ amount: '150', currency: 'JPY' });
  });

  it('refuses a result whose amounts are still Money, so a missed conversion fails on the server', () => {
    expect(taxCalculationResultSchema.safeParse(calculation).success).toBe(false);
  });
});

describe('customerTaxSummarySchema', () => {
  it('sends each amount as exact text with its currency', () => {
    const summary = {
      totalTaxPaid: [money('12.34', 'EUR')],
      totalTransactions: 2,
      breakdown: [{ jurisdiction: 'DE', taxAmount: money('12.34', 'EUR'), transactionCount: 2 }],
    };

    const sent = customerTaxSummarySchema.parse(customerTaxSummaryJson(summary));

    expect(sent.totalTaxPaid).toEqual([{ amount: '12.34', currency: 'EUR' }]);
    expect(sent.breakdown[0]?.taxAmount).toEqual({ amount: '12.34', currency: 'EUR' });
  });
});

describe('taxComplianceReportSchema', () => {
  it('converts the totals and the category amounts, and keeps the dates', () => {
    const startDate = instant('2026-01-01T00:00:00.000Z');
    const report: TaxComplianceReport = {
      id: 'report_1',
      reportType: 'vat',
      period: { year: 2026, quarter: 1, startDate, endDate: instant('2026-03-31T00:00:00.000Z') },
      jurisdiction: 'all',
      totalSales: money('1000.000', 'KWD'),
      totalTaxCollected: money('50.125', 'KWD'),
      exemptSales: money(0, 'KWD'),
      transactions: 3,
      generatedAt: startDate,
      summary: {
        taxableTransactions: 3,
        exemptTransactions: 0,
        averageTaxRate: 5,
        topTaxCategories: [{ category: 'SaaS', sales: money('1000.000', 'KWD'), tax: money('50.125', 'KWD') }],
      },
    };

    const sent = taxComplianceReportSchema.parse(taxComplianceReportJson(report));

    expect(sent.totalTaxCollected).toEqual({ amount: '50.125', currency: 'KWD' });
    expect(sent.summary.topTaxCategories[0]?.tax).toEqual({ amount: '50.125', currency: 'KWD' });
    expect(sent.period.startDate).toEqual(startDate);
  });
});
