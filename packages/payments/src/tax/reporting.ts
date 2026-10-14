import type { Instant } from '@arki/date';
import { compareAsc, fromDate, now, sub } from '@arki/date';
import { getLogger } from '@arki/log';
import { Money, sum } from '@arki/money';

import type { PaymentRepository } from '../core/repository.js';
import type { CustomerId } from '../core/types.js';
import type { ExemptionType } from './primitives.js';
import type {
  TaxAuditRepository,
  TaxConfigurationRepository,
  TaxExemptionRepository,
  TaxJurisdictionRepository,
  TaxRecordRepository,
} from './repository.js';
import type { TaxExemption } from './types.js';
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
  /** What succeeded payments of the period brought in, one total per currency, ordered by currency code */
  totalSales: Money[];
  /** Tax collected on sales less tax given back on refunds, per currency */
  totalTaxCollected: Money[];
  /** Sales to customers with a blanket exemption in force, per currency */
  exemptSales: Money[];
  transactions: number;
  generatedAt: Instant;
  summary: {
    taxableTransactions: number;
    exemptTransactions: number;
    /** Mean, over taxable payments, of tax as a share of the sale before tax (0.19 is 19%). A ratio, not an amount. */
    averageTaxRate: number;
    /** One row per category and currency, ordered by category then currency */
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

/** What the reports read. The repositories of `createTaxRepositories` and a `PaymentRepository` fit. */
export type TaxReportReads = {
  payments: Pick<PaymentRepository, 'findPayments'>;
  exemptions: Pick<
    TaxExemptionRepository,
    'findCustomerExemptionsInRange' | 'findExemptionsInRange' | 'findExpiringExemptions'
  >;
  records: Pick<TaxRecordRepository, 'totalsByJurisdiction' | 'totalsByPayment'>;
  audit: Pick<TaxAuditRepository, 'record' | 'findByEntity'>;
  configurations: Pick<TaxConfigurationRepository, 'findDefaultConfiguration'>;
  jurisdictions: Pick<TaxJurisdictionRepository, 'findActiveJurisdictions'>;
};

const logger = getLogger('arki:payments:tax-reporting');

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

/** One succeeded payment of the period, with the tax recorded for it. */
export type TaxExportRow = {
  id: string;
  date: Instant;
  customerId: string | null;
  type: 'subscription' | 'one_time';
  amount: Money;
  tax: Money;
  /** Zero tax because the customer held a blanket exemption at the time */
  exempt: boolean;
  description: string;
};

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
   * Generate the tax compliance report of a period, from what the package stored: the succeeded
   * payments, the tax records and the exemptions. Stripe Tax has no report endpoint, so nothing is
   * fetched from it. `reportType` names the report; the records do not tell VAT from sales tax.
   * `jurisdiction` (any case) limits the tax, and the payments to those it taxed.
   */
  async generateComplianceReport(params: {
    reportType: 'sales_and_use_tax' | 'vat' | 'gst';
    period: ReportingPeriod;
    jurisdiction?: string;
  }): Promise<TaxComplianceReport> {
    const aggregate = await this.aggregateLocalTransactions(params.period, params.jurisdiction);

    return {
      id: `${params.reportType}:${params.jurisdiction ?? 'all'}:${params.period.startDate.toString()}`,
      reportType: params.reportType,
      period: params.period,
      jurisdiction: params.jurisdiction ?? 'all',
      totalSales: aggregate.totalSales,
      totalTaxCollected: aggregate.totalTax,
      exemptSales: aggregate.exemptSales,
      transactions: aggregate.rows.length,
      generatedAt: now(),
      summary: {
        taxableTransactions: aggregate.taxableCount,
        exemptTransactions: aggregate.exemptCount,
        averageTaxRate: aggregate.averageTaxRate,
        topTaxCategories: aggregate.categories,
      },
    };
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
   * Create audit trail entry for tax-related actions. The entry is stored; `id` and `timestamp` are the stored ones.
   */
  async createAuditEntry(entry: Omit<TaxAuditEntry, 'id' | 'timestamp'>): Promise<TaxAuditEntry> {
    const row = await this.reads.audit.record({
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      details: entry.details,
    });

    return { id: row.id, timestamp: row.occurredAt, action: row.action, entity: row.entity, entityId: row.entityId, details: row.details };
  }

  /** The audit entries about one entity, oldest first. */
  async getAuditTrail(entity: TaxAuditEntry['entity'], entityId: string): Promise<TaxAuditEntry[]> {
    const rows = await this.reads.audit.findByEntity(entity, entityId);

    return rows.map(row => ({
      id: row.id,
      timestamp: row.occurredAt,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      details: row.details,
    }));
  }

  /**
   * The next filing deadline of each jurisdiction we are registered in. A jurisdiction is listed
   * when it requires registration, has a monthly, quarterly or annual `filingFrequency`, and the
   * default tax configuration holds an active registration for its country. The deadline is the
   * end (UTC) of the month after the filing period closes: the jurisdiction row stores no due day,
   * so this is the common rule, not a statute. Nearest first.
   */
  async getUpcomingDeadlines(asOf: Instant = now()): Promise<{
    jurisdiction: string;
    type: string;
    deadline: Instant;
    description: string;
    priority: 'high' | 'medium' | 'low';
  }[]> {
    const [jurisdictions, configuration] = await Promise.all([
      this.reads.jurisdictions.findActiveJurisdictions(),
      this.reads.configurations.findDefaultConfiguration(),
    ]);
    const registered = new Set(
      (configuration?.businessDetails?.registrations ?? [])
        .filter(registration => registration.status === 'active')
        .map(registration => registration.country.toUpperCase()),
    );

    const lengths: Record<string, { months: number; label: string }> = {
      monthly: { months: 1, label: 'Monthly' },
      quarterly: { months: 3, label: 'Quarterly' },
      annual: { months: 12, label: 'Annual' },
      yearly: { months: 12, label: 'Annual' },
    };
    const asOfDate = new Date(asOf.toString());
    const asOfMillis = asOfDate.getTime();
    const dayMillis = 86_400_000;

    const deadlines = [];
    for (const jurisdiction of jurisdictions) {
      if (!jurisdiction.registrationRequired || !registered.has(jurisdiction.countryCode.toUpperCase())) continue;
      const length = lengths[(jurisdiction.filingFrequency ?? '').toLowerCase()];
      if (!length) {
        logger.debug('Jurisdiction {code} has no filing frequency this service can schedule', { code: jurisdiction.code });
        continue;
      }

      // Months counted from year 0; a period of `months` ends in each month whose (index + 1) divides evenly
      let periodEnd = asOfDate.getUTCFullYear() * 12 + asOfDate.getUTCMonth() - 12;
      let deadlineMillis: number;
      for (;; periodEnd += 1) {
        if ((periodEnd + 1) % length.months !== 0) continue;
        const nextMonth = periodEnd + 1;
        const candidate = Date.UTC(Math.floor(nextMonth / 12), (nextMonth % 12) + 1, 1) - 1;
        if (candidate >= asOfMillis) {
          deadlineMillis = candidate;
          break;
        }
      }

      const daysLeft = (deadlineMillis - asOfMillis) / dayMillis;
      deadlines.push({
        jurisdiction: jurisdiction.name,
        type: `${length.label} filing`,
        deadline: fromDate(new Date(deadlineMillis)),
        description: `${length.label} tax filing for ${jurisdiction.name}`,
        priority: daysLeft <= 14 ? ('high' as const) : daysLeft <= 45 ? ('medium' as const) : ('low' as const),
        millis: deadlineMillis,
      });
    }

    return deadlines
      .toSorted((a, b) => a.millis - b.millis || a.jurisdiction.localeCompare(b.jurisdiction))
      .map(({ millis: _millis, ...deadline }) => deadline);
  }

  /**
   * Validate tax compliance status from what is stored: every active jurisdiction that requires
   * registration needs an active registration for its country in the default tax configuration
   * (none, or an inactive one, is critical; a pending one is a warning), and exemptions ending
   * within 30 days are a warning.
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
    const issues: Awaited<ReturnType<TaxReportingService['validateComplianceStatus']>>['issues'] = [];

    const expiring = await this.reads.exemptions.findExpiringExemptions(30);
    if (expiring.length > 0) {
      issues.push({
        type: 'expired_exemption',
        jurisdiction: 'multiple',
        description: `${expiring.length} tax exemptions expiring within 30 days`,
        severity: 'warning',
      });
    }

    const [jurisdictions, configuration] = await Promise.all([
      this.reads.jurisdictions.findActiveJurisdictions(),
      this.reads.configurations.findDefaultConfiguration(),
    ]);
    const registrations = configuration?.businessDetails?.registrations ?? [];
    const required = new Map<string, string>();
    for (const jurisdiction of jurisdictions) {
      if (jurisdiction.registrationRequired) required.set(jurisdiction.countryCode.toUpperCase(), jurisdiction.name);
    }
    for (const [country, name] of required) {
      const ofCountry = registrations.filter(registration => registration.country.toUpperCase() === country);
      if (ofCountry.some(registration => registration.status === 'active')) continue;
      const pending = ofCountry.some(registration => registration.status === 'pending');
      issues.push({
        type: 'missing_registration',
        jurisdiction: country,
        description: pending
          ? `Tax registration for ${name} is still pending`
          : `No active tax registration for ${name}, which requires one`,
        severity: pending ? 'warning' : 'critical',
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
   * Export tax data for external systems: one row per succeeded payment of the period with the tax
   * recorded for it, and with `includeExemptions` one row per exemption in force in the period.
   * CSV values are quoted when they need it, and text that a spreadsheet would run as a formula is
   * prefixed with a quote. XML text is escaped, and characters XML 1.0 cannot hold are dropped.
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
    const aggregate = await this.aggregateLocalTransactions(params.period);
    const exemptions = params.includeExemptions
      ? await this.reads.exemptions.findExemptionsInRange(params.period.startDate, params.period.endDate)
      : [];

    const filename = `tax_export_${params.period.year}${params.period.quarter ? `_Q${params.period.quarter}` : ''}${params.period.month ? `_M${params.period.month}` : ''}.${params.format}`;

    let data: string;
    switch (params.format) {
      case 'csv': {
        data = formatAsCSV(aggregate.rows, exemptions);
        break;
      }
      case 'json': {
        data = JSON.stringify(
          {
            period: { year: params.period.year, start: params.period.startDate.toString(), end: params.period.endDate.toString() },
            totalSales: aggregate.totalSales,
            totalTaxCollected: aggregate.totalTax,
            transactions: aggregate.rows.map(row => ({
              id: row.id,
              date: row.date.toString(),
              customerId: row.customerId,
              type: row.type,
              amount: row.amount,
              tax: row.tax,
              exempt: row.exempt,
              description: row.description,
            })),
            exemptions: exemptions.map(exemption => exemptionRow(exemption)),
          },
          null,
          2,
        );
        break;
      }
      case 'xml': {
        data = formatAsXML(aggregate.rows, exemptions);
        break;
      }
      default: {
        throw new Error('Unsupported export format');
      }
    }

    return { format: params.format, data, filename };
  }

  // Private helper methods

  /**
   * The succeeded payments of the period with their tax. Tax per payment is what the tax records
   * hold under its payment id (sales less refunds); a payment with none carried none. Collected
   * tax is every record of the period, so it includes tax recorded without a payment id.
   */
  private async aggregateLocalTransactions(period: ReportingPeriod, jurisdiction?: string) {
    const { startDate: start, endDate: end } = period;
    const taxByPayment = new Map<string, Money>();
    const paymentTotals = await this.reads.records.totalsByPayment({ start, end, jurisdiction });
    for (const row of paymentTotals) {
      taxByPayment.set(row.paymentId, Money.fromMinor(row.saleTaxMinor - row.refundTaxMinor, row.currency));
    }

    const exemptionsByCustomer = new Map<string, TaxExemption[]>();
    const blanketExemptionAt = async (customerId: string | null, at: Instant) => {
      if (customerId === null) return false;
      let held = exemptionsByCustomer.get(customerId);
      if (!held) {
        const inRange = await this.reads.exemptions.findCustomerExemptionsInRange(customerId, start, end);
        held = inRange.filter(
          exemption => exemption.productCode === null && exemption.jurisdictionId === null,
        );
        exemptionsByCustomer.set(customerId, held);
      }

      return held.some(
        exemption =>
          compareAsc(exemption.validFrom, at) <= 0 && (exemption.validTo === null || compareAsc(exemption.validTo, at) > 0),
      );
    };

    const rows: TaxExportRow[] = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.reads.payments.findPayments({
        status: 'succeeded',
        startDate: start,
        endDate: end,
        limit: pageSize,
        offset,
      });

      for (const payment of page) {
        const taxed = taxByPayment.get(payment.id);
        if (jurisdiction !== undefined && taxed === undefined) continue;
        const amount = Money.fromMinor(payment.amountMinor, payment.currency.toUpperCase());
        const tax = taxed ?? Money.zero(amount.currency.code);
        rows.push({
          id: payment.id,
          date: payment.createdAt,
          customerId: payment.customerId ?? null,
          type: payment.subscriptionId ? 'subscription' : 'one_time',
          amount,
          tax,
          exempt: tax.isZero() && (await blanketExemptionAt(payment.customerId ?? null, payment.createdAt)),
          description: payment.description ?? '',
        });
      }

      if (page.length < pageSize) break;
    }

    const collected = await this.reads.records.totalsByJurisdiction({ start, end, jurisdiction });

    const taxable = rows.filter(row => row.tax.isPositive());
    const categories = new Map<string, { category: string; sales: Money[]; tax: Money[]; currency: string }>();
    for (const row of rows) {
      const category = row.type === 'subscription' ? 'Subscriptions' : 'One-time payments';
      const currency = row.amount.currency.code;
      const entry = categories.get(`${category}\u0000${currency}`) ?? { category, sales: [], tax: [], currency };
      entry.sales.push(row.amount);
      entry.tax.push(row.tax);
      categories.set(`${category}\u0000${currency}`, entry);
    }

    return {
      rows,
      totalSales: totalsByCurrency(rows.map(row => row.amount)),
      totalTax: totalsByCurrency(collected.map(row => Money.fromMinor(row.saleTaxMinor - row.refundTaxMinor, row.currency))),
      exemptSales: totalsByCurrency(rows.filter(row => row.exempt).map(row => row.amount)),
      taxableCount: taxable.length,
      exemptCount: rows.filter(row => row.exempt).length,
      // A ratio of two amounts in one currency, so it is the same in any currency
      averageTaxRate:
        taxable.length === 0
          ? 0
          : taxable.reduce((total, row) => total + row.tax.toMinorNumber() / (row.amount.toMinorNumber() - row.tax.toMinorNumber()), 0) /
            taxable.length,
      categories: [...categories.values()]
        .toSorted((a, b) => a.category.localeCompare(b.category) || a.currency.localeCompare(b.currency))
        .map(entry => ({
          category: entry.category,
          sales: sum(entry.sales, entry.currency),
          tax: sum(entry.tax, entry.currency),
        })),
    };
  }
}

/** One export row about an exemption. */
function exemptionRow(exemption: TaxExemption) {
  return {
    id: exemption.id,
    type: exemption.type,
    customerId: exemption.customerId,
    reason: exemption.reason,
    certificateNumber: exemption.certificateNumber,
    validFrom: exemption.validFrom.toString(),
    validTo: exemption.validTo?.toString() ?? null,
  };
}

/**
 * One CSV field. Quoted when it holds a comma, a quote or a line break, with quotes doubled.
 * Text a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, tab, CR first) gets a leading `'`.
 */
function csvField(value: string, options: { text: boolean }): string {
  const guarded = options.text && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;

  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

function formatAsCSV(rows: readonly TaxExportRow[], exemptions: readonly TaxExemption[]): string {
  const lines = ['record_type,id,date,customer_id,type,currency,amount,tax,exempt,description'];
  for (const row of rows) {
    lines.push(
      [
        'payment',
        csvField(row.id, { text: true }),
        row.date.toString(),
        csvField(row.customerId ?? '', { text: true }),
        row.type,
        row.amount.currency.code,
        row.amount.toDecimalString(),
        row.tax.toDecimalString(),
        String(row.exempt),
        csvField(row.description, { text: true }),
      ].join(','),
    );
  }
  for (const exemption of exemptions) {
    lines.push(
      [
        'exemption',
        csvField(exemption.id, { text: true }),
        exemption.validFrom.toString(),
        csvField(exemption.customerId ?? '', { text: true }),
        exemption.type,
        '',
        '',
        '',
        'true',
        csvField(exemption.reason, { text: true }),
      ].join(','),
    );
  }

  return `${lines.join('\r\n')}\r\n`;
}

/** Whether XML 1.0 can hold the code point. Control characters (but tab, line feed, carriage return), U+FFFE and U+FFFF cannot. */
function isXmlChar(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0A ||
    code === 0x0D ||
    (code >= 0x20 && code <= 0xD7_FF) ||
    (code >= 0xE0_00 && code <= 0xFF_FD) ||
    (code >= 0x1_00_00 && code <= 0x10_FF_FF)
  );
}

function xmlText(value: string): string {
  // Iterating a string by code point turns a lone surrogate into one code point in 0xd800..0xdfff: dropped
  return [...value]
    .filter(char => isXmlChar(char.codePointAt(0) ?? 0))
    .join('')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function element(name: string, value: string, indent: string): string {
  return `${indent}<${name}>${xmlText(value)}</${name}>`;
}

function formatAsXML(rows: readonly TaxExportRow[], exemptions: readonly TaxExemption[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<tax_report>', '  <transactions>'];
  for (const row of rows) {
    lines.push(
      '    <transaction>',
      element('id', row.id, '      '),
      element('date', row.date.toString(), '      '),
      element('customer_id', row.customerId ?? '', '      '),
      element('type', row.type, '      '),
      element('currency', row.amount.currency.code, '      '),
      element('amount', row.amount.toDecimalString(), '      '),
      element('tax', row.tax.toDecimalString(), '      '),
      element('exempt', String(row.exempt), '      '),
      element('description', row.description, '      '),
      '    </transaction>',
    );
  }
  lines.push('  </transactions>');
  if (exemptions.length > 0) {
    lines.push('  <exemptions>');
    for (const exemption of exemptions) {
      lines.push(
        '    <exemption>',
        element('id', exemption.id, '      '),
        element('type', exemption.type, '      '),
        element('customer_id', exemption.customerId ?? '', '      '),
        element('reason', exemption.reason, '      '),
        element('valid_from', exemption.validFrom.toString(), '      '),
        element('valid_to', exemption.validTo?.toString() ?? '', '      '),
        '    </exemption>',
      );
    }
    lines.push('  </exemptions>');
  }
  lines.push('</tax_report>');

  return `${lines.join('\n')}\n`;
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
 * const reportingService = createTaxReportingService({ payments, ...createTaxRepositories(db, tables) });
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