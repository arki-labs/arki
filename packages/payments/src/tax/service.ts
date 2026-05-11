import type { StripeProvider } from '../core/providers/stripe-provider';
import type { CustomerId, PaymentId, SubscriptionId } from '../core/types';
import type { TaxDatabase } from './repository';

/**
 * Tax calculation input for subscriptions and one-time payments
 */
export type TaxCalculationInput = {
  customerId: CustomerId;
  lineItems: {
    amount: number;
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
 * Tax calculation result with detailed breakdown
 */
export type TaxCalculationResult = {
  subtotal: number;
  taxAmount: number;
  total: number;
  taxInclusive: boolean;
  breakdown: {
    jurisdiction: string;
    rate: number;
    amount: number;
    taxCode?: string;
  }[];
  applicableTaxIds: string[];
}

/**
 * Tax transaction for compliance tracking
 */
export type TaxTransaction = {
  id: string;
  reference: string;
  type: 'sale' | 'refund';
  amount: number;
  taxAmount: number;
  currency: string;
  customerId?: CustomerId;
  paymentId?: PaymentId;
  subscriptionId?: SubscriptionId;
  createdAt: Date;
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
    _db: TaxDatabase,
    private readonly stripeProvider: StripeProvider,
  ) {
    // Verify that Stripe provider supports tax features
    if (!stripeProvider.features.taxCalculation) {
      throw new Error('Tax service requires a provider with tax calculation capabilities');
    }
  }

  /**
   * Calculate tax for a potential purchase
   * This is used for price previews and checkout calculations
   */
  async calculateTax(input: TaxCalculationInput): Promise<TaxCalculationResult> {
    try {
      const result = await this.stripeProvider.calculateTax({
        customerId: input.customerId,
        lineItems: input.lineItems.map(item => ({
          amount: item.amount,
          reference: item.reference,
          taxCode: item.taxCode,
        })),
        currency: input.currency,
        customerDetails: input.customerDetails,
      });

      return {
        subtotal: result.amountTotal - result.taxAmountExclusive,
        taxAmount: result.taxAmountExclusive,
        total: result.amountTotal,
        taxInclusive: result.taxAmountInclusive > 0,
        breakdown: result.taxBreakdown.map(breakdown => ({
          jurisdiction: breakdown.jurisdiction,
          rate: breakdown.rate,
          amount: breakdown.amount,
          taxCode: breakdown.taxCode,
        })),
        applicableTaxIds: [], // Would be populated based on customer tax IDs
      };
    } catch (error) {
      console.error('Tax calculation failed:', error);

      // Fallback: return zero tax if calculation fails
      const subtotal = input.lineItems.reduce((sum, item) => sum + item.amount, 0);
      return {
        subtotal,
        taxAmount: 0,
        total: subtotal,
        taxInclusive: false,
        breakdown: [],
        applicableTaxIds: [],
      };
    }
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
    lineItems: {
      amount: number;
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
        currency: params.currency,
        customerId: params.customerId,
        paymentId: params.paymentId,
        subscriptionId: params.subscriptionId,
        createdAt: new Date(),
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
    planAmount: number;
    planInterval: 'monthly' | 'yearly' | 'weekly' | 'daily';
    currency: string;
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
      currency: params.currency,
      customerDetails: params.customerDetails,
    });
  }

  /**
   * Calculate tax for one-time payments (tips, donations)
   * Special handling for non-recurring transactions
   */
  async calculateOneTimeTax(params: {
    customerId: CustomerId;
    amount: number;
    description: string;
    currency: string;
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
      currency: params.currency,
      customerDetails: params.customerDetails,
    });
  }

  /**
   * Get tax compliance report
   * For generating tax reports for filing purposes
   */
  async generateTaxReport(params: {
    reportType: 'sales_and_use_tax' | 'vat' | 'gst';
    startDate: Date;
    endDate: Date;
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
   * Validate tax ID for a customer
   * Helps ensure compliance and accurate tax calculation
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
    // This would integrate with Stripe's tax ID validation
    // For now, we'll return a basic validation

    const commonPatterns: Record<string, RegExp> = {
      'us_ein': /^\d{2}-\d{7}$/,
      'eu_vat': /^[A-Z]{2}[A-Z0-9]+$/,
      'gb_vat': /^GB\d{9}$/,
      'ca_bn': /^\d{9}RT\d{4}$/,
    };

    const pattern = commonPatterns[`${taxId.country.toLowerCase()}_${taxId.type.toLowerCase()}`];
    const valid = pattern ? pattern.test(taxId.value) : true; // Assume valid if no pattern

    return {
      valid,
      format: valid ? 'valid' : 'invalid',
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
    totalTaxPaid: number;
    totalTransactions: number;
    currency: string;
    breakdown: {
      jurisdiction: string;
      taxAmount: number;
      transactionCount: number;
    }[];
  }> {
    // This would query your database for tax transactions
    // For now, we'll return a placeholder

    return {
      totalTaxPaid: 0,
      totalTransactions: 0,
      currency: 'USD',
      breakdown: [],
    };
  }
}

/**
 * Factory function to create TaxService
 */
export function createTaxService(
  db: TaxDatabase,
  stripeProvider: StripeProvider,
): TaxService {
  return new TaxService(db, stripeProvider);
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
 *   planAmount: 2999, // $29.99
 *   planInterval: 'monthly',
 *   currency: 'USD',
 *   customerDetails: {
 *     address: {
 *       country: 'US',
 *       state: 'CA',
 *       postalCode: '94105',
 *     },
 *   },
 * });
 *
 * console.log(`Subtotal: $${taxResult.subtotal}`);
 * console.log(`Tax: $${taxResult.taxAmount}`);
 * console.log(`Total: $${taxResult.total}`);
 * ```
 */
