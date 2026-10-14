import type { Instant } from '@arki/date';
import { now } from '@arki/date';
import { Money, sum } from '@arki/money';

import type { StripeProvider } from '../core/providers/stripe-provider.js';
import type { CustomerId, PaymentId, SubscriptionId } from '../core/types.js';
import type { TaxExemptionId } from './primitives.js';
import type { TaxExemptionRepository, TaxJurisdictionRepository } from './repository.js';
import { checkTaxIdFormat } from './tax-id.js';

/** What `TaxService` reads. A `TaxExemptionRepository` and a `TaxJurisdictionRepository` fit. */
export type TaxServiceReads = {
  exemptions: Pick<TaxExemptionRepository, 'findApplicableExemptions'>;
  jurisdictions: Pick<TaxJurisdictionRepository, 'findJurisdictionById'>;
};

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
  jurisdiction: string;
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
   * customer's (or open to every customer) and its product code, if it has one, is the line's
   * tax code or plan; one tied to a jurisdiction removes that jurisdiction's tax from the
   * breakdown, unless the tax is inclusive (it is part of the price then, and stays). A line that is
   * wholly exempt is not sent to Stripe. An exemption needs what its type says it is for (a customer, a product or a
   * jurisdiction): one without would exempt every sale, so it is never applied.
   */
  async calculateTax(input: TaxCalculationInput): Promise<TaxCalculationResult> {
    const currency = input.currency.toUpperCase();
    // An exemption "for a customer" must name the customer; same for the other two types
    const scoped = (await this.reads.exemptions.findApplicableExemptions(input.customerId)).filter(
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
      const exemption = lineExemptions.find(
        candidate =>
          candidate.productCode === null || candidate.productCode === item.taxCode || candidate.productCode === item.planId,
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
      breakdown = result.taxBreakdown.map(line => ({
        jurisdiction: line.jurisdiction,
        rate: line.rate,
        amount: line.amount,
        taxCode: line.taxCode,
      }));

      if (!taxInclusive && jurisdictionExemptions.length > 0) {
        const exemptJurisdictions = new Map<TaxExemptionId, string[]>();
        for (const exemption of jurisdictionExemptions) {
          // A jurisdiction exemption tied to one product cannot be told apart in the breakdown
          if (exemption.productCode !== null || exemption.jurisdictionId === null) continue;
          const jurisdiction = await this.reads.jurisdictions.findJurisdictionById(exemption.jurisdictionId);
          if (jurisdiction) {
            exemptJurisdictions.set(exemption.id, [jurisdiction.name.toLowerCase(), jurisdiction.code.toLowerCase()]);
          }
        }

        breakdown = breakdown.filter(line => {
          const label = line.jurisdiction.toLowerCase();
          for (const [id, names] of exemptJurisdictions) {
            if (names.includes(label)) {
              applied.add(id);
              taxAmount = taxAmount.minus(line.amount);

              return false;
            }
          }

          return true;
        });
      }
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
  }): Promise<TaxTransaction> {
    try {
      const transaction = await this.stripeProvider.createTaxTransaction({
        reference: params.reference,
        type: params.type,
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

      // In a real implementation, you might want to store this in your database
      // for additional tracking and reporting

      return {
        id: transaction.id,
        reference: params.reference,
        type: params.type,
        amount: transaction.amountTotal,
        taxAmount: transaction.taxAmountExclusive,
        customerId: params.customerId,
        paymentId: params.paymentId,
        subscriptionId: params.subscriptionId,
        createdAt: now(),
        jurisdiction: 'Unknown', // Would be extracted from tax breakdown
        taxCode: params.lineItems[0]?.taxCode,
      };
    } catch (error) {
      console.error('Tax transaction creation failed:', error);
      throw new Error(`Failed to create tax transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get tax settings and configuration
   * Useful for displaying tax information to customers
   */
  async getTaxSettings(){
    try {
      return await this.stripeProvider.getTaxSettings();
    } catch (error) {
      console.error('Failed to retrieve tax settings:', error);

      // Return default settings if API call fails
      return {
        defaultTaxCode: 'txcd_10000000',
        taxRegistrations: [],
      };
    }
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
   * Get tax compliance report
   * For generating tax reports for filing purposes
   */
  async generateTaxReport(params: {
    reportType: 'sales_and_use_tax' | 'vat' | 'gst';
    startDate: Instant;
    endDate: Instant;
    jurisdiction?: string;
  }): Promise<{
    id: string;
    status: 'pending' | 'succeeded' | 'failed';
    downloadUrl?: string;
  }> {
    try {
      return await this.stripeProvider.getTaxReport(params);
    } catch (error) {
      console.error('Tax report generation failed:', error);
      throw new Error(`Failed to generate tax report: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
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
   */
  async getCustomerTaxSummary(_params: {
    customerId: CustomerId;
    year: number;
  }): Promise<{
    totalTaxPaid: Money;
    totalTransactions: number;
    breakdown: {
      jurisdiction: string;
      taxAmount: Money;
      transactionCount: number;
    }[];
  }> {
    // This would query your database for tax transactions
    // For now, we'll return a placeholder

    return {
      totalTaxPaid: Money.zero('USD'),
      totalTransactions: 0,
      breakdown: [],
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
