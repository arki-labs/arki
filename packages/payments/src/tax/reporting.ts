import type { Instant } from '@arki/date';
import { fromDate, now, sub } from '@arki/date';
import { Money, money, sum } from '@arki/money';

import type { PaymentRepository } from '../core/repository.js';
import type { CustomerId } from '../core/types.js';
import type { ExemptionType } from './primitives.js';
import type { TaxExemptionRepository } from './repository.js';
import { moneyJsonSchema } from '../core/money.js';

/**
 * Tax compliance and reporting periods
 */
export type ReportingPeriod = {
  year: number;
  quarter?: number;
  month?: number;
  startDate: Instant;
  endDate: Instant;
};

/**
 * Tax compliance report data
 */
export type TaxComplianceReport = {
  id: string;
  reportType: 'sales_and_use_tax' | 'vat' | 'gst';
  period: ReportingPeriod;
  jurisdiction: string;
  totalSales: Money;
  totalTaxCollected: Money;
  exemptSales: Money;
  transactions: number;
  generatedAt: Instant;
  summary: {
    taxableTransactions: number;
    exemptTransactions: number;
    averageTaxRate: number;
    topTaxCategories: {
      category: string;
      sales: Money;
      tax: Money;
    }[];
  };
}

/**
 * Customer tax summary for compliance
 *
 * Built from the customer's succeeded payments of the calendar year (UTC). A payment's tax is the
 * `taxAmount` its metadata records at checkout; a payment without one carried no recorded tax and
 * counts zero. Totals are one amount per currency: currencies are never added.
 */
export type CustomerTaxSummary = {
  customerId: string;
  year: number;
  /** One total per currency, ordered by currency code. */
  totalPaid: Money[];
  totalTax: Money[];
  transactions: {
    id: string;
    date: Instant;
    amount: Money;
    tax: Money;
    type: 'subscription' | 'one_time';
    description: string;
  }[];
  /** Exemptions that were in force at some point in the year. */
  exemptions: {
    type: ExemptionType;
    reason: string;
    certificateNumber: string | null;
    validFrom: Instant;
    validTo: Instant | null;
  }[];
}

/** What the customer summary reads. A `PaymentRepository` and a `TaxExemptionRepository` fit. */
export type TaxReportReads = {
  payments: Pick<PaymentRepository, 'findPayments'>;
  exemptions: Pick<TaxExemptionRepository, 'findCustomerExemptionsInRange'>;
};

/**
 * Tax audit trail entry
 */
export type TaxAuditEntry = {
  id: string;
  timestamp: Instant;
  action: 'calculate' | 'apply' | 'refund' | 'exempt' | 'report';
  entity: 'payment' | 'subscription' | 'customer' | 'exemption';
  entityId: string;
  details: {
    before?: unknown;
    after?: unknown;
    reason?: string;
    userId?: string;
    metadata?: Record<string, unknown>;
  };
}

/** The amounts summed per currency, ordered by currency code. Exact; currencies are never added. */
function totalsByCurrency(amounts: readonly Money[]): Money[] {
  const byCurrency = new Map<string, Money[]>();
  for (const amount of amounts) {
    byCurrency.set(amount.currency.code, [...(byCurrency.get(amount.currency.code) ?? []), amount]);
  }

  return [...byCurrency.entries()].toSorted(([a], [b]) => a.localeCompare(b)).map(([code, items]) => sum(items, code));
}

/**
 * The tax a payment recorded in its metadata at checkout (`taxAmount`, `Money` JSON), as `Money`
 * in the payment's currency. No `taxAmount` means no tax was recorded: zero. One that is not
 * `Money` JSON, or is in another currency than the payment, throws: a wrong total must not pass.
 */
function recordedTax(paymentId: string, metadata: Record<string, unknown> | null, currency: string): Money {
  const recorded = metadata?.taxAmount;
  if (recorded === undefined || recorded === null) return Money.zero(currency);

  const parsed = moneyJsonSchema.safeParse(recorded);
  if (!parsed.success) {
    throw new Error(`Payment ${paymentId} has a taxAmount that is not money: ${JSON.stringify(recorded)}`);
  }
  const tax = Money.fromJSON(parsed.data);
  if (tax.currency.code !== currency) {
    throw new Error(`Payment ${paymentId} is in ${currency} but records tax in ${tax.currency.code}`);
  }

  return tax;
}

/**
 * Tax Reporting and Compliance Service
 *
 * Provides comprehensive tax reporting, compliance tracking,
 * and audit trail functionality for tax operations.
 */
export class TaxReportingService {
  constructor(private readonly reads: TaxReportReads) {}

  /**
   * Generate comprehensive tax compliance report
   */
  async generateComplianceReport(params: {
    reportType: 'sales_and_use_tax' | 'vat' | 'gst';
    period: ReportingPeriod;
    jurisdiction?: string;
  }): Promise<TaxComplianceReport> {
    try {
      // Aggregate local transaction data
      const localSummary = await this.aggregateLocalTransactions(params.period);

      // Calculate summary statistics
      const summary = {
        taxableTransactions: localSummary.taxableCount,
        exemptTransactions: localSummary.exemptCount,
        // A display ratio of two amounts in one currency, not an amount
        averageTaxRate: localSummary.totalTax.toMinorNumber() / localSummary.totalSales.toMinorNumber() || 0,
        topTaxCategories: localSummary.categories,
      };

      const report: TaxComplianceReport = {
        id: `${params.reportType}:${params.jurisdiction ?? 'all'}:${params.period.startDate.toString()}`,
        reportType: params.reportType,
        period: params.period,
        jurisdiction: params.jurisdiction || 'all',
        totalSales: localSummary.totalSales,
        totalTaxCollected: localSummary.totalTax,
        exemptSales: localSummary.exemptSales,
        transactions: localSummary.transactionCount,
        generatedAt: now(),
        summary,
      };

      return report;
    } catch (error) {
      console.error('Failed to generate compliance report:', error);
      throw new Error(`Failed to generate compliance report: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get customer tax summary for a specific year (UTC): the customer's succeeded payments with the
   * tax recorded on each, and the exemptions in force during the year.
   */
  async getCustomerTaxSummary(customerId: CustomerId, year: number): Promise<CustomerTaxSummary> {
    const startDate = fromDate(new Date(Date.UTC(year, 0, 1)));
    const endDate = sub(fromDate(new Date(Date.UTC(year + 1, 0, 1))), { nanoseconds: 1 });

    const transactions: CustomerTaxSummary['transactions'] = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.reads.payments.findPayments({
        status: 'succeeded',
        customerId,
        startDate,
        endDate,
        limit: pageSize,
        offset,
      });

      for (const payment of page) {
        const amount = Money.fromMinor(payment.amountMinor, payment.currency.toUpperCase());
        transactions.push({
          id: payment.id,
          date: payment.createdAt,
          amount,
          tax: recordedTax(payment.id, payment.metadata, amount.currency.code),
          type: payment.subscriptionId ? 'subscription' : 'one_time',
          description: payment.description ?? '',
        });
      }

      if (page.length < pageSize) break;
    }

    const exemptions = await this.reads.exemptions.findCustomerExemptionsInRange(customerId, startDate, endDate);

    return {
      customerId,
      year,
      totalPaid: totalsByCurrency(transactions.map((t) => t.amount)),
      totalTax: totalsByCurrency(transactions.map((t) => t.tax)),
      transactions,
      exemptions: exemptions.map((exemption) => ({
        type: exemption.type,
        reason: exemption.reason,
        certificateNumber: exemption.certificateNumber,
        validFrom: exemption.validFrom,
        validTo: exemption.validTo,
      })),
    };
  }

  /**
   * Create audit trail entry for tax-related actions
   */
  async createAuditEntry(entry: Omit<TaxAuditEntry, 'id' | 'timestamp'>): Promise<TaxAuditEntry> {
    const auditEntry: TaxAuditEntry = {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      timestamp: now(),
      ...entry,
    };

    // In a real implementation, this would be stored in the database
    console.log('Tax audit entry created:', auditEntry);

    return auditEntry;
  }

  /**
   * Get upcoming tax filing deadlines
   */
  async getUpcomingDeadlines(): Promise<{
    jurisdiction: string;
    type: string;
    deadline: Instant;
    description: string;
    priority: 'high' | 'medium' | 'low';
  }[]> {
    // This would integrate with tax jurisdiction data to calculate deadlines
    // Local-time calendar boundaries, as before.
    const currentDate = new Date();
    const nextQuarter = fromDate(new Date(currentDate.getFullYear(), Math.floor(currentDate.getMonth() / 3) * 3 + 3, 0));
    const nextYear = fromDate(new Date(currentDate.getFullYear() + 1, 0, 31));

    return [
      {
        jurisdiction: 'US',
        type: 'Quarterly Sales Tax',
        deadline: nextQuarter,
        description: 'Q3 2024 sales tax filing for US jurisdictions',
        priority: 'high',
      },
      {
        jurisdiction: 'EU',
        type: 'VAT Return',
        deadline: nextYear,
        description: 'Annual VAT return for EU sales',
        priority: 'medium',
      },
    ];
  }

  /**
   * Validate tax compliance status
   */
  async validateComplianceStatus(): Promise<{
    status: 'compliant' | 'warning' | 'non_compliant';
    issues: {
      type: 'missing_registration' | 'expired_exemption' | 'overdue_filing' | 'missing_documentation';
      jurisdiction: string;
      description: string;
      severity: 'critical' | 'warning' | 'info';
    }[];
  }> {
    const issues = [];

    // Check for expiring exemptions (would need to access repositories correctly)
    // For now, placeholder logic
    const expiringExemptions: unknown[] = []; // await context.repo.paymentsTax.exemptions.findExpiringExemptions(30);
    if (expiringExemptions.length > 0) {
      issues.push({
        type: 'expired_exemption' as const,
        jurisdiction: 'multiple',
        description: `${expiringExemptions.length} tax exemptions expiring within 30 days`,
        severity: 'warning' as const,
      });
    }

    // Check for missing tax registrations (placeholder logic)
    const hasUSRegistration = true; // Would check database
    if (!hasUSRegistration) {
      issues.push({
        type: 'missing_registration' as const,
        jurisdiction: 'US',
        description: 'Missing sales tax registration for US operations',
        severity: 'critical' as const,
      });
    }

    const status = issues.some(i => i.severity === 'critical')
      ? 'non_compliant'
      : issues.length > 0
        ? 'warning'
        : 'compliant';

    return { status, issues };
  }

  /**
   * Export tax data for external systems
   */
  async exportTaxData(params: {
    format: 'csv' | 'json' | 'xml';
    period: ReportingPeriod;
    includeExemptions?: boolean;
  }): Promise<{
    format: string;
    data: string;
    filename: string;
  }> {
    const transactions = await this.aggregateLocalTransactions(params.period);

    const filename = `tax_export_${params.period.year}${params.period.quarter ? `_Q${params.period.quarter}` : ''}.${params.format}`;

    let data: string;

    switch (params.format) {
      case 'csv': {
        data = this.formatAsCSV(transactions);
        break;
      }
      case 'json': {
        data = JSON.stringify(transactions, null, 2);
        break;
      }
      case 'xml': {
        data = this.formatAsXML(transactions);
        break;
      }
      default: {
        throw new Error(`Unsupported format: ${params.format}`);
      }
    }

    return { format: params.format, data, filename };
  }

  // Private helper methods

  private async aggregateLocalTransactions(_period: ReportingPeriod) {
    // This would perform complex database aggregations
    // For now, return placeholder data
    return {
      totalSales: money(50_000, 'USD'),
      totalTax: money(4500, 'USD'),
      exemptSales: money(2000, 'USD'),
      taxableCount: 150,
      exemptCount: 10,
      transactionCount: 160,
      categories: [
        { category: 'SaaS Subscriptions', sales: money(40_000, 'USD'), tax: money(3600, 'USD') },
        { category: 'One-time Payments', sales: money(10_000, 'USD'), tax: money(900, 'USD') },
      ],
    };
  }

  private formatAsCSV(_data: unknown): string {
    // Simple CSV formatting - would be more sophisticated in reality
    return 'Date,Amount,Tax,Type,Description\n' +
           '2024-01-15,29.99,2.70,subscription,Pro Plan - Monthly\n';
  }

  private formatAsXML(_data: unknown): string {
    // Simple XML formatting - would be more sophisticated in reality
    return `<?xml version="1.0" encoding="UTF-8"?>
<tax_report>
  <transactions>
    <transaction>
      <date>2024-01-15</date>
      <amount>29.99</amount>
      <tax>2.70</tax>
      <type>subscription</type>
      <description>Pro Plan - Monthly</description>
    </transaction>
  </transactions>
</tax_report>`;
  }
}

/**
 * Factory function to create TaxReportingService
 */
export function createTaxReportingService(reads: TaxReportReads): TaxReportingService {
  return new TaxReportingService(reads);
}

/**
 * Tax Reporting and Compliance Module
 *
 * This module provides comprehensive tax reporting and compliance capabilities,
 * including audit trails, compliance validation, and regulatory reporting.
 *
 * ## Key Features:
 *
 * ### Compliance Reporting
 * - Generate sales tax, VAT, and GST reports
 * - Multi-jurisdiction support
 * - Automated deadline tracking
 * - Compliance status validation
 *
 * ### Customer Tax Summaries
 * - Annual tax summaries for customers
 * - Transaction-level tax breakdown
 * - Exemption tracking and validation
 * - Multi-currency support
 *
 * ### Audit and Documentation
 * - Complete audit trail for all tax operations
 * - Export capabilities for external systems
 * - Documentation management for exemptions
 * - Regulatory compliance validation
 *
 * ## Usage Examples:
 *
 * ```typescript
 * const reportingService = createTaxReportingService(db, stripeProvider);
 *
 * // Generate quarterly sales tax report
 * const report = await reportingService.generateComplianceReport({
 *   reportType: 'sales_and_use_tax',
 *   period: {
 *     year: 2024,
 *     quarter: 3,
 *     startDate: new Date('2024-07-01'),
 *     endDate: new Date('2024-09-30'),
 *   },
 *   jurisdiction: 'US',
 * });
 *
 * // Get customer tax summary
 * const customerSummary = await reportingService.getCustomerTaxSummary('cus_123', 2024);
 *
 * // Validate compliance status
 * const compliance = await reportingService.validateComplianceStatus();
 * ```
 */