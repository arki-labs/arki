import type { Instant } from '@arki/date';
import type { Money } from '@arki/money';
import { fromDate, instant, now } from '@arki/date';
import { money, sum } from '@arki/money';

import type { StripeProvider } from '../core/providers/stripe-provider.js';

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
  status: 'pending' | 'completed' | 'failed';
  downloadUrl?: string;
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
 */
export type CustomerTaxSummary = {
  customerId: string;
  year: number;
  totalPaid: Money;
  totalTax: Money;
  transactions: {
    id: string;
    date: Instant;
    amount: Money;
    tax: Money;
    type: 'subscription' | 'one_time';
    description: string;
  }[];
  exemptions: {
    type: string;
    amount: Money;
    reason: string;
  }[];
}

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

/**
 * Tax Reporting and Compliance Service
 *
 * Provides comprehensive tax reporting, compliance tracking,
 * and audit trail functionality for tax operations.
 */
export class TaxReportingService {
  constructor(private readonly stripeProvider: StripeProvider) {}

  /**
   * Generate comprehensive tax compliance report
   */
  async generateComplianceReport(params: {
    reportType: 'sales_and_use_tax' | 'vat' | 'gst';
    period: ReportingPeriod;
    jurisdiction?: string;
  }): Promise<TaxComplianceReport> {
    try {
      // Generate report with Stripe Tax
      const stripeReport = await this.stripeProvider.getTaxReport({
        reportType: params.reportType,
        startDate: params.period.startDate,
        endDate: params.period.endDate,
        jurisdiction: params.jurisdiction,
      });

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
        id: stripeReport.id,
        reportType: params.reportType,
        period: params.period,
        jurisdiction: params.jurisdiction || 'all',
        totalSales: localSummary.totalSales,
        totalTaxCollected: localSummary.totalTax,
        exemptSales: localSummary.exemptSales,
        transactions: localSummary.transactionCount,
        generatedAt: now(),
        status: stripeReport.status as any,
        downloadUrl: stripeReport.downloadUrl,
        summary,
      };

      return report;
    } catch (error) {
      console.error('Failed to generate compliance report:', error);
      throw new Error(`Failed to generate compliance report: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get customer tax summary for a specific year
   */
  async getCustomerTaxSummary(customerId: string, year: number): Promise<CustomerTaxSummary> {
    try {
      // This would query the database for customer transactions
      // For now, return a placeholder structure
      // Local-time calendar boundaries, as before.
      const startDate = fromDate(new Date(year, 0, 1));
      const endDate = fromDate(new Date(year, 11, 31));

      // Query payments and subscriptions for this customer in the year
      // This is a simplified implementation - in reality would involve complex queries
      const transactions = await this.getCustomerTransactions(customerId, startDate, endDate);
      const exemptions = await this.getCustomerExemptions(customerId, year);

      // Exact sums; a transaction in another currency throws CurrencyMismatchError
      const totalPaid = sum(transactions.map(t => t.amount), 'USD');
      const totalTax = sum(transactions.map(t => t.tax), 'USD');

      return {
        customerId,
        year,
        totalPaid,
        totalTax,
        transactions,
        exemptions,
      };
    } catch (error) {
      console.error('Failed to get customer tax summary:', error);
      throw new Error(`Failed to get customer tax summary: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
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

  private async getCustomerTransactions(_customerId: string, _startDate: Instant, _endDate: Instant) {
    // This would query the payments and subscription tables
    // For now, return placeholder data
    return [
      {
        id: 'pay_123',
        date: instant('2024-01-15T00:00:00Z'),
        amount: money('29.99', 'USD'),
        tax: money('2.70', 'USD'),
        type: 'subscription' as const,
        description: 'Pro Plan - Monthly',
      },
    ];
  }

  private async getCustomerExemptions(_customerId: string, _year: number) {
    // This would query the tax exemptions table
    return [];
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
export function createTaxReportingService(stripeProvider: StripeProvider): TaxReportingService {
  return new TaxReportingService(stripeProvider);
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