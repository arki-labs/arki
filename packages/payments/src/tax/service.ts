import type { Instant } from '@arki/date';
import { fromDate, now, sub } from '@arki/date';
import { getLogger } from '@arki/log';
import { Money, sum } from '@arki/money';

import type { StripeProvider } from '../core/providers/stripe-provider.js';
import type { CustomerId, PaymentId, SubscriptionId } from '../core/types.js';
import type { TaxExemptionId } from './primitives.js';
import type { TaxExemptionRepository, TaxJurisdictionRepository, TaxRecordRepository } from './repository.js';
import type { TaxJurisdiction } from './types.js';
import { checkTaxIdFormat } from './tax-id.js';

/** What `TaxService` reads. A `TaxExemptionRepository` and a `TaxJurisdictionRepository` fit. */
export type TaxServiceReads = {
  exemptions: Pick<TaxExemptionRepository, 'findApplicableExemptions'>;
  jurisdictions: Pick<TaxJurisdictionRepository, 'findJurisdictionById'>;
  records: Pick<TaxRecordRepository, 'findByReference' | 'recordMany' | 'totalsByJurisdiction' | 'countSaleTransactions'>;
};

const logger = getLogger('arki:payments:tax');

type TaxBreakdownLine = Awaited<ReturnType<StripeProvider['calculateTax']>>['taxBreakdown'][number];

/** How Stripe names the level of each jurisdiction type of ours. */
const STRIPE_LEVEL: Record<TaxJurisdiction['type'], string> = {
  country: 'country',
  state: 'state',
  province: 'state',
  city: 'city',
  county: 'county',
  district: 'district',
};

/** A subdivision code as Stripe writes it: upper case, without the country prefix (`US-CA` is `CA`). */
const subdivisionCode = (code: string) => code.trim().toUpperCase().replace(/^[A-Z]{2}-/, '');

/**
 * True when Stripe's tax line is the tax of our jurisdiction. The display name alone cannot say:
 * Georgia is a US state and a country. The line must be in the same country, at the same level, and
 * in the same state. Stripe gives no code below the state, so a city, county or district must also
 * carry the same name. A jurisdiction that cannot be placed this way matches nothing: tax is charged
 * rather than wrongly waived.
 */
export function jurisdictionOwnsLine(jurisdiction: TaxJurisdiction, line: TaxBreakdownLine): boolean {
  if (line.country.toUpperCase() !== jurisdiction.countryCode.toUpperCase()) return false;
  if (line.level !== STRIPE_LEVEL[jurisdiction.type]) return false;
  if (jurisdiction.type === 'country') return true;

  const state = line.state === undefined ? undefined : subdivisionCode(line.state);
  if (jurisdiction.type === 'state' || jurisdiction.type === 'province') {
    const wanted = subdivisionCode(jurisdiction.stateCode ?? jurisdiction.code);

    return state === wanted;
  }

  if (jurisdiction.stateCode !== null && state !== subdivisionCode(jurisdiction.stateCode)) return false;

  return line.jurisdiction.toLowerCase() === jurisdiction.name.toLowerCase();
}

/**
 * Tax calculation input for subscriptions and one-time payments
 */
export type TaxCalculationInput = {
  customerId: CustomerId;
  /** Every line item is in `currency` */
  lineItems: {
    amount: Money;
    description: string;
    reference: string;
    taxCode?: string;
    planId?: string;
  }[];
  currency: string;
  customerDetails?: {
    address?: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
    };
    taxIds?: {
      type: string;
      value: string;
    }[];
  };
}

/**
 * Tax calculation result with detailed breakdown.
 * Stripe Tax computes and rounds the tax; the amounts here are its, exactly.
 */
export type TaxCalculationResult = {
  subtotal: Money;
  taxAmount: Money;
  total: Money;
  taxInclusive: boolean;
  breakdown: {
    jurisdiction: string;
    rate: number;
    amount: Money;
    taxCode?: string;
  }[];
  /** The customer's tax IDs whose format is valid for their type and country. */
  applicableTaxIds: string[];
  /** The exemptions that kept tax off this sale, in whole or in part. */
  appliedExemptionIds: TaxExemptionId[];
}

/**
 * Tax transaction for compliance tracking
 */
export type TaxTransaction = {
  id: string;
  reference: string;
  type: 'sale' | 'refund';
  amount: Money;
  taxAmount: Money;
  customerId?: CustomerId;
  paymentId?: PaymentId;
  subscriptionId?: SubscriptionId;
  createdAt: Instant;
  /** The tax in each jurisdiction, as recorded. They add up to `taxAmount`. */
  breakdown: {
    jurisdiction: string;
    taxAmount: Money;
  }[];
  taxCode?: string;
}

/**
 * Tax Service for managing tax calculations, compliance, and reporting
 *
 * This service provides a high-level interface for tax operations,
 * integrating with Stripe Tax for calculations while maintaining
 * audit trails and business logic.
 */
export class TaxService {
  constructor(
    private readonly stripeProvider: StripeProvider,
    private readonly reads: TaxServiceReads,
  ) {
    // Verify that Stripe provider supports tax features
    if (!stripeProvider.features.taxCalculation) {
      throw new Error('Tax service requires a provider with tax calculation capabilities');
    }
  }

  /**
   * Calculate tax for a potential purchase
   * This is used for price previews and checkout calculations
   *
   * Exemptions in force are applied. An active exemption keeps tax off a line when it is the
   * customer's own, or open to every customer but then tied to a product that is the line's tax
   * code or plan (a global exemption with no product would zero everyone's tax, so it never applies); one tied to a jurisdiction removes that jurisdiction's tax from the
   * breakdown, unless the tax is inclusive (it is part of the price then, and stays). A line that is
   * wholly exempt is not sent to Stripe. An exemption needs what its type says it is for (a customer, a product or a
   * jurisdiction): one without would exempt every sale, so it is never applied.
   */
  async calculateTax(input: TaxCalculationInput): Promise<TaxCalculationResult> {
    const currency = input.currency.toUpperCase();
    // An exemption "for a customer" must name the customer; same for the other two types
    const applicable = await this.reads.exemptions.findApplicableExemptions(input.customerId);
    const scoped = applicable.filter(
      exemption =>
        (exemption.type !== 'customer' || exemption.customerId !== null) &&
        (exemption.type !== 'product' || exemption.productCode !== null) &&
        (exemption.type !== 'jurisdiction' || exemption.jurisdictionId !== null),
    );
    const lineExemptions = scoped.filter(exemption => exemption.jurisdictionId === null);
    const jurisdictionExemptions = scoped.filter(exemption => exemption.jurisdictionId !== null);

    const applied = new Set<TaxExemptionId>();
    const taxableLines: TaxCalculationInput['lineItems'] = [];
    const exemptLines: TaxCalculationInput['lineItems'] = [];
    for (const item of input.lineItems) {
      // A blanket exemption (no product) exempts every line, so it must be this customer's own.
      // One open to every customer must name the product it is for, and match it exactly.
      const exemption = lineExemptions.find(candidate =>
        candidate.productCode === null
          ? candidate.customerId === input.customerId
          : candidate.productCode === item.taxCode || candidate.productCode === item.planId,
      );
      if (exemption) {
        applied.add(exemption.id);
        exemptLines.push(item);
      } else {
        taxableLines.push(item);
      }
    }

    const exemptSubtotal = sum(
      exemptLines.map(item => item.amount),
      currency,
    );

    let subtotal = exemptSubtotal;
    let taxAmount = Money.zero(currency);
    let taxInclusive = false;
    let breakdown: TaxCalculationResult['breakdown'] = [];

    if (taxableLines.length > 0) {
      // A failure is the caller's to handle: a checkout must not go on with tax it does not know.
      // The provider throws `PaymentProviderError`; its `retryable` says whether trying again can help.
      const result = await this.stripeProvider.calculateTax({
        customerId: input.customerId,
        lineItems: taxableLines.map(item => ({
          amount: item.amount,
          reference: item.reference,
          taxCode: item.taxCode,
        })),
        currency: input.currency,
        customerDetails: input.customerDetails,
      });

      subtotal = exemptSubtotal.plus(result.amountTotal.minus(result.taxAmountExclusive));
      taxAmount = result.taxAmountExclusive;
      taxInclusive = result.taxAmountInclusive.isPositive();
      let lines = result.taxBreakdown;

      if (!taxInclusive && jurisdictionExemptions.length > 0) {
        const exemptJurisdictions = new Map<TaxExemptionId, TaxJurisdiction>();
        for (const exemption of jurisdictionExemptions) {
          // A jurisdiction exemption tied to one product cannot be told apart in the breakdown
          if (exemption.productCode !== null || exemption.jurisdictionId === null) continue;
          const jurisdiction = await this.reads.jurisdictions.findJurisdictionById(exemption.jurisdictionId);
          if (jurisdiction) {
            exemptJurisdictions.set(exemption.id, jurisdiction);
          }
        }

        lines = lines.filter(line => {
          for (const [id, jurisdiction] of exemptJurisdictions) {
            if (jurisdictionOwnsLine(jurisdiction, line)) {
              applied.add(id);
              taxAmount = taxAmount.minus(line.amount);

              return false;
            }
          }

          return true;
        });
      }

      breakdown = lines.map(line => ({
        jurisdiction: line.jurisdiction,
        rate: line.rate,
        amount: line.amount,
        taxCode: line.taxCode,
      }));
    }

    return {
      subtotal,
      taxAmount,
      total: subtotal.plus(taxAmount),
      taxInclusive,
      breakdown,
      applicableTaxIds: (input.customerDetails?.taxIds ?? [])
        .filter(
          taxId =>
            input.customerDetails?.address?.country !== undefined &&
            checkTaxIdFormat({ ...taxId, country: input.customerDetails.address.country }).format === 'valid',
        )
        .map(taxId => taxId.value),
      appliedExemptionIds: [...applied],
    };
  }

  /**
   * Create a tax transaction for compliance tracking
   * Called when a payment is successful or a refund is processed
   *
   * `breakdown` is the tax the checkout's `calculateTax` returned for this sale. It is stored, one
   * record per jurisdiction and rate, and is what `getCustomerTaxSummary` and the compliance report
   * add up. Recording a `reference` twice (for the same `type`) returns the first record and does
   * not call the provider again. A failure is the caller's to handle, as in `calculateTax`.
   */
  async createTaxTransaction(params: {
    reference: string;
    type: 'sale' | 'refund';
    customerId?: CustomerId;
    paymentId?: PaymentId;
    subscriptionId?: SubscriptionId;
    /** Every line item is in `currency` */
    lineItems: {
      amount: Money;
      description: string;
      reference: string;
      taxCode?: string;
    }[];
    currency: string;
    customerDetails?: TaxCalculationInput['customerDetails'];
    /** The tax by jurisdiction, from `calculateTax`; every amount is in `currency` */
    breakdown: TaxCalculationResult['breakdown'];
    /** When the sale or refund happened. Defaults to now. */
    occurredAt?: Instant;
    /** For a `refund`: the `reference` of the recorded sale it reverses. Required there, ignored for a sale. */
    originalReference?: string;
  }): Promise<TaxTransaction> {
    const currency = params.currency.toUpperCase();
    const taxCode = params.lineItems[0]?.taxCode;

    // Per jurisdiction and rate: one record each, whatever number of lines carried it
    const grouped = new Map<string, { jurisdiction: string; rate: number; amounts: Money[] }>();
    for (const line of params.breakdown) {
      if (line.amount.currency.code !== currency) {
        throw new Error(
          `Tax for ${line.jurisdiction} is in ${line.amount.currency.code}, but the transaction ${params.reference} is in ${currency}`,
        );
      }
      const key = `${line.jurisdiction}\u0000${line.rate}`;
      const entry = grouped.get(key) ?? { jurisdiction: line.jurisdiction, rate: line.rate, amounts: [] };
      entry.amounts.push(line.amount);
      grouped.set(key, entry);
    }
    const lines = [...grouped.values()].map(entry => ({ ...entry, taxAmount: sum(entry.amounts, currency) }));
    const taxAmount = sum(
      lines.map(line => line.taxAmount),
      currency,
    );

    const existing = await this.reads.records.findByReference(params.type, params.reference);
    const first = existing[0];
    if (first) {
      logger.debug('Tax transaction {reference} was already recorded', { reference: params.reference });

      return {
        id: first.providerTransactionId ?? first.id,
        reference: params.reference,
        type: params.type,
        amount: sum(
          params.lineItems.map(item => item.amount),
          currency,
        ),
        taxAmount: sum(
          existing.map(record => Money.fromMinor(record.taxAmountMinor, record.currency)),
          currency,
        ),
        customerId: params.customerId,
        paymentId: params.paymentId,
        subscriptionId: params.subscriptionId,
        createdAt: first.occurredAt,
        breakdown: existing.map(record => ({
          jurisdiction: record.jurisdiction,
          taxAmount: Money.fromMinor(record.taxAmountMinor, record.currency),
        })),
        taxCode,
      };
    }

    let originalTransactionId: string | undefined;
    if (params.type === 'refund') {
      if (params.originalReference === undefined) {
        throw new Error(`Refund ${params.reference} needs originalReference: the reference of the sale it reverses`);
      }
      const original = await this.reads.records.findByReference('sale', params.originalReference);
      originalTransactionId = original.find(record => record.providerTransactionId !== null)?.providerTransactionId ?? undefined;
      if (originalTransactionId === undefined) {
        throw new Error(`Refund ${params.reference} reverses sale ${params.originalReference}, which was never recorded`);
      }
    }

    const transaction = await this.stripeProvider.createTaxTransaction({
      reference: params.reference,
      type: params.type,
      originalTransactionId,
      customerId: params.customerId,
      lineItems: params.lineItems.map(item => ({
        amount: item.amount,
        quantity: 1,
        reference: item.reference,
        taxCode: item.taxCode,
      })),
      currency: params.currency,
      customerDetails: params.customerDetails,
    });

    // The provider worked the tax out itself; the records are the caller's breakdown. They should agree.
    const recorded = transaction.taxAmountExclusive.plus(transaction.taxAmountInclusive).abs();
    if (recorded.toMinorNumber() !== taxAmount.toMinorNumber()) {
      logger.warn('Tax transaction {reference}: the provider recorded {recorded} tax, the breakdown says {breakdown}', {
        reference: params.reference,
        recorded: recorded.toString(),
        breakdown: taxAmount.toString(),
      });
    }

    const createdAt = params.occurredAt ?? now();
    await this.reads.records.recordMany(
      lines.map(line => ({
        reference: params.reference,
        type: params.type,
        jurisdiction: line.jurisdiction,
        rate: String(line.rate),
        taxAmountMinor: line.taxAmount.toMinorNumber(),
        currency,
        taxCode,
        customerId: params.customerId,
        paymentId: params.paymentId,
        subscriptionId: params.subscriptionId,
        providerTransactionId: transaction.id,
        occurredAt: createdAt,
      })),
    );

    return {
      id: transaction.id,
      reference: params.reference,
      type: params.type,
      amount: transaction.amountTotal,
      taxAmount,
      customerId: params.customerId,
      paymentId: params.paymentId,
      subscriptionId: params.subscriptionId,
      createdAt,
      breakdown: lines.map(line => ({ jurisdiction: line.jurisdiction, taxAmount: line.taxAmount })),
      taxCode,
    };
  }

  /**
   * Get tax settings and configuration
   * Useful for displaying tax information to customers
   */
  async getTaxSettings() {
    // A failure is the caller's: settings made up on error would show a default tax code the account does not use.
    return this.stripeProvider.getTaxSettings();
  }

  /**
   * Calculate tax for subscription plans
   * Special handling for recurring billing scenarios
   */
  async calculateSubscriptionTax(params: {
    customerId: CustomerId;
    planAmount: Money;
    planInterval: 'monthly' | 'yearly' | 'weekly' | 'daily';
    taxCode?: string;
    customerDetails?: TaxCalculationInput['customerDetails'];
  }): Promise<TaxCalculationResult> {
    return this.calculateTax({
      customerId: params.customerId,
      lineItems: [{
        amount: params.planAmount,
        description: `Subscription (${params.planInterval})`,
        reference: `subscription_${params.planInterval}`,
        taxCode: params.taxCode || 'txcd_10103000', // Software-as-a-Service tax code
      }],
      currency: params.planAmount.currency.code,
      customerDetails: params.customerDetails,
    });
  }

  /**
   * Calculate tax for one-time payments (tips, donations)
   * Special handling for non-recurring transactions
   */
  async calculateOneTimeTax(params: {
    customerId: CustomerId;
    amount: Money;
    description: string;
    taxCode?: string;
    customerDetails?: TaxCalculationInput['customerDetails'];
  }): Promise<TaxCalculationResult> {
    return this.calculateTax({
      customerId: params.customerId,
      lineItems: [{
        amount: params.amount,
        description: params.description,
        reference: `onetime_${Date.now()}`,
        taxCode: params.taxCode || 'txcd_10000000', // General tax code
      }],
      currency: params.amount.currency.code,
      customerDetails: params.customerDetails,
    });
  }

  /**
   * Check the format of a customer's tax ID. The format only: whether the number is registered
   * takes the registry (VIES, HMRC, the IRS). `format: 'unknown'` means no format is known for
   * the type (or for the country under `eu_vat`); the ID is then not `valid`.
   */
  async validateTaxId(taxId: {
    type: string;
    value: string;
    country: string;
  }): Promise<{
    valid: boolean;
    format: 'valid' | 'invalid' | 'unknown';
    country?: string;
    type?: string;
  }> {
    const { format } = checkTaxIdFormat(taxId);

    return {
      // `unknown` means no format is known for the type: it was not checked, so it is not valid
      valid: format === 'valid',
      format,
      country: taxId.country,
      type: taxId.type,
    };
  }

  /**
   * Get tax summary for a customer
   * Useful for customer portals and tax reporting
   *
   * Built from the tax records of the calendar year (UTC): what each jurisdiction collected on the
   * customer's sales, less what it gave back on refunds. Totals are one `Money` per currency
   * (never added across currencies), ordered by currency code; `breakdown` has one row per
   * jurisdiction and currency. `totalTransactions` counts the sales that carried tax.
   */
  async getCustomerTaxSummary(params: {
    customerId: CustomerId;
    year: number;
  }): Promise<{
    totalTaxPaid: Money[];
    totalTransactions: number;
    breakdown: {
      jurisdiction: string;
      taxAmount: Money;
      transactionCount: number;
    }[];
  }> {
    const start = fromDate(new Date(Date.UTC(params.year, 0, 1)));
    const end = sub(fromDate(new Date(Date.UTC(params.year + 1, 0, 1))), { nanoseconds: 1 });
    const period = { start, end, customerId: params.customerId };
    const totals = await this.reads.records.totalsByJurisdiction(period);

    const breakdown = totals.map(total => ({
      jurisdiction: total.jurisdiction,
      taxAmount: Money.fromMinor(total.saleTaxMinor - total.refundTaxMinor, total.currency),
      transactionCount: total.saleCount,
    }));

    const byCurrency = new Map<string, Money[]>();
    for (const line of breakdown) {
      byCurrency.set(line.taxAmount.currency.code, [...(byCurrency.get(line.taxAmount.currency.code) ?? []), line.taxAmount]);
    }

    return {
      totalTaxPaid: [...byCurrency.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([code, amounts]) => sum(amounts, code)),
      totalTransactions: await this.reads.records.countSaleTransactions(period),
      breakdown,
    };
  }
}

/**
 * Factory function to create TaxService
 */
export function createTaxService(stripeProvider: StripeProvider, reads: TaxServiceReads): TaxService {
  return new TaxService(stripeProvider, reads);
}

/**
 * Tax Service Module
 *
 * This module provides comprehensive tax calculation and compliance capabilities
 * for the payment system, leveraging Stripe Tax for accurate calculations while
 * maintaining business logic and audit trails.
 *
 * ## Key Features:
 *
 * ### Tax Calculation
 * - **Real-time Calculations**: Accurate tax rates based on customer location
 * - **Multi-jurisdiction Support**: Handles VAT, GST, sales tax, and more
 * - **Product-specific Tax Codes**: Different rates for SaaS vs. digital goods
 *
 * ### Compliance Tracking
 * - **Transaction Recording**: Complete audit trail for tax purposes
 * - **Tax ID Validation**: Verify customer tax IDs for accuracy
 * - **Compliance Reporting**: Generate reports for tax filing
 *
 * ### Integration Points
 * - Subscription tax calculation for recurring billing
 * - One-time payment tax for tips and donations
 * - Refund tax handling for compliance
 * - Customer portal tax summaries
 *
 * ## Common Tax Codes:
 * - `txcd_10000000`: General - tangible personal property
 * - `txcd_10103000`: Software as a Service (SaaS)
 * - `txcd_10501000`: Digital products
 * - `txcd_99999999`: Nontaxable
 *
 * ## Usage Example:
 *
 * ```typescript
 * import { createTaxService } from '@/features/payments/tax';
 *
 * const taxService = createTaxService(db, stripeProvider);
 *
 * // Calculate tax for a subscription
 * const taxResult = await taxService.calculateSubscriptionTax({
 *   customerId: 'cus_123',
 *   planAmount: money('29.99', 'USD'),
 *   planInterval: 'monthly',
 *   customerDetails: {
 *     address: {
 *       country: 'US',
 *       state: 'CA',
 *       postalCode: '94105',
 *     },
 *   },
 * });
 *
 * formatMoney(taxResult.subtotal); // '$29.99'
 * formatMoney(taxResult.taxAmount);
 * formatMoney(taxResult.total);
 * ```
 */
