// Fixture setup needs scalar IDs; stop before the scenario if entropy is unavailable.
/**
 * Tax compliance reports, exports, audit trail and checks: from stored data
 *
 * These used to answer fixed numbers (50,000 USD of sales, a 2024-01-15 CSV row,
 * "registered in the US" always true, an audit entry that only logged). Each
 * test here stores real rows and reads them back through the real repositories
 * on PGlite.
 */
import type { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { instant } from '@arki/date';
import { orThrow } from '@arki/failure';

import type { PaymentId } from '../core/types.js';
import { createCustomerId } from '../core/primitives.js';
import { PaymentRepository } from '../core/repository.js';
import { runnerOn } from '../service-test-support.js';
import { adminId, core, customerId, openDb, schema, typed, userId } from '../test-support.js';
import { createTaxReportingService } from './reporting.js';
import { createTaxRepositories } from './repository.js';
import { createTaxTables } from './tables.js';

const tax = createTaxTables({ schema });
const otherCustomerId = orThrow(createCustomerId());

const relations = defineRelations(
  { plans: core.plans, customers: core.customers, subscriptions: core.subscriptions, payments: core.payments },
  r => ({
    subscriptions: {
      plan: r.one.plans({ from: r.subscriptions.planId, to: r.plans.id }),
      customer: r.one.customers({ from: r.subscriptions.customerId, to: r.customers.id }),
    },
    payments: {
      subscription: r.one.subscriptions({ from: r.payments.subscriptionId, to: r.subscriptions.id }),
      customer: r.one.customers({ from: r.payments.customerId, to: r.customers.id }),
    },
  }),
);

const year = 2033;
const period = {
  year,
  startDate: instant(`${year}-01-01T00:00:00Z`),
  endDate: instant(`${year}-12-31T23:59:59Z`),
};

let client: PGlite;
let writes: ReturnType<typeof typed.core.writes>;
let reporting: ReturnType<typeof createTaxReportingService>;
let repos: ReturnType<typeof createTaxRepositories>;
let counter = 0;

async function payment(options: { customer?: typeof customerId; amount: string; description?: string }): Promise<PaymentId> {
  counter += 1;
  const customer = options.customer ?? customerId;
  const created = await orThrow(
    writes.initiatePayment({
      userId: customer === customerId ? userId : adminId,
      customerId: customer,
      providerPaymentId: `pi_cmp_${counter}`,
      amount: { amount: options.amount, currency: 'EUR' },
      description: options.description,
    }),
  );
  await orThrow(writes.completePayment({ paymentId: created.id }));

  return created.id;
}

beforeAll(async () => {
  const opened = await openDb({
    ...tax.enums,
    taxJurisdictions: tax.taxJurisdictions,
    taxExemptions: tax.taxExemptions,
    taxConfigurations: tax.taxConfigurations,
    taxRecords: tax.taxRecords,
    taxAuditEntries: tax.taxAuditEntries,
  });
  client = opened.client;
  writes = typed.core.writes(runnerOn(opened.db));
  await opened.db
    .insert(core.customers)
    .values({ id: otherCustomerId, userId: adminId, providerCustomerId: 'cus_o', email: 'o@example.com' });

  const db = drizzle({ client, relations });
  repos = createTaxRepositories(db, tax);
  reporting = createTaxReportingService({ payments: new PaymentRepository(db, core), ...repos });
});

afterAll(async () => {
  await client.close();
});

/** Payments are created now, so the report period is the current year; records are dated in it too. */
function thisYearPeriod() {
  const y = new Date().getUTCFullYear();

  return { year: y, startDate: instant(`${y}-01-01T00:00:00Z`), endDate: instant(`${y + 1}-01-01T00:00:00Z`) };
}

describe('compliance report and export from stored data', () => {
  let taxed: PaymentId;

  beforeAll(async () => {
    taxed = await payment({ customer: customerId, amount: '119', description: 'He said "hi", ok\nsecond line' });
    await payment({ customer: otherCustomerId, amount: '50', description: '=HYPERLINK("http://evil")' });
    await payment({ customer: customerId, amount: '10', description: 'Fish & <chips>\u0007' });
    await repos.records.recordMany([
      { reference: 'o1', type: 'sale', jurisdiction: 'Germany', rate: '19', taxAmountMinor: 1900, currency: 'EUR', customerId, paymentId: taxed },
    ]);
    orThrow(await repos.exemptions.createExemption({
      type: 'customer',
      status: 'active',
      customerId: otherCustomerId,
      exemptionCode: 'NONPROFIT',
      reason: 'Charity, "registered"',
      validFrom: instant('2020-01-01T00:00:00Z'),
    }));
  });

  it('adds up real payments and tax: sales, tax collected, exempt sales, counts and categories', async () => {
    const report = await reporting.generateComplianceReport({ reportType: 'vat', period: thisYearPeriod() });

    expect(report.totalSales.map(t => t.toJSON())).toEqual([{ amount: '179.00', currency: 'EUR' }]);
    expect(report.totalTaxCollected.map(t => t.toJSON())).toEqual([{ amount: '19.00', currency: 'EUR' }]);
    expect(report.exemptSales.map(t => t.toJSON())).toEqual([{ amount: '50.00', currency: 'EUR' }]);
    expect(report.transactions).toBe(3);
    expect(report.summary.taxableTransactions).toBe(1);
    expect(report.summary.exemptTransactions).toBe(1);
    // 19 tax on 100 before tax
    expect(report.summary.averageTaxRate).toBeCloseTo(0.19, 10);
    expect(report.summary.topTaxCategories.map(c => [c.category, c.sales.toDecimalString(), c.tax.toDecimalString()])).toEqual([
      ['One-time payments', '179.00', '19.00'],
    ]);
  });

  it('limits the report to one jurisdiction, in any case', async () => {
    const report = await reporting.generateComplianceReport({ reportType: 'vat', period: thisYearPeriod(), jurisdiction: 'germany' });

    expect(report.transactions).toBe(1);
    expect(report.totalSales.map(t => t.toDecimalString())).toEqual(['119.00']);
    expect(report.jurisdiction).toBe('germany');
  });

  it('is empty for a period without sales, not a made-up 50,000', async () => {
    const report = await reporting.generateComplianceReport({ reportType: 'vat', period });

    expect(report.transactions).toBe(0);
    expect(report.totalSales).toEqual([]);
    expect(report.summary.averageTaxRate).toBe(0);
  });

  it('exports CSV that a parser reads back: quotes, commas and line breaks quoted, formulas defused', async () => {
    const { data, filename } = await reporting.exportTaxData({ format: 'csv', period: thisYearPeriod(), includeExemptions: true });

    expect(filename).toBe(`tax_export_${thisYearPeriod().year}.csv`);
    expect(data).not.toContain('2024-01-15');
    expect(data).toContain(`"He said ""hi"", ok\nsecond line"`);
    // The formula is neutralised and, holding quotes, still a single quoted field
    expect(data).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(data.split('\r\n')[0]).toBe('record_type,id,date,customer_id,type,currency,amount,tax,exempt,description');
    expect(data).toContain('exemption,');
    expect(data).toContain('"Charity, ""registered"""');
    expect(data).toContain(',EUR,119.00,19.00,false,');
  });

  it('exports XML with text escaped and characters XML cannot hold dropped', async () => {
    const { data } = await reporting.exportTaxData({ format: 'xml', period: thisYearPeriod() });

    expect(data).toContain('<description>Fish &amp; &lt;chips&gt;</description>');
    expect(data).not.toContain('\u0007');
    expect(data).toContain('<description>He said &quot;hi&quot;, ok\nsecond line</description>');
    expect(data).not.toContain('<exemptions>');
    expect(data.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it('exports JSON with the same rows', async () => {
    const { data } = await reporting.exportTaxData({ format: 'json', period: thisYearPeriod() });
    const parsed: { transactions: { amount: { amount: string }; tax: { amount: string } }[] } = JSON.parse(data);

    expect(parsed.transactions.map(t => [t.amount.amount, t.tax.amount]).toSorted()).toEqual([
      ['10.00', '0.00'],
      ['119.00', '19.00'],
      ['50.00', '0.00'],
    ]);
  });
});

describe('audit trail', () => {
  it('stores the entry, and reads it back with the id and time the database gave', async () => {
    const created = await reporting.createAuditEntry({
      action: 'exempt',
      entity: 'exemption',
      entityId: 'txe_1',
      details: { reason: 'certificate checked', userId: 'usr_admin', metadata: { certificate: 'CERT-1' } },
    });
    await reporting.createAuditEntry({ action: 'report', entity: 'customer', entityId: 'cust_x', details: {} });

    const trail = await reporting.getAuditTrail('exemption', 'txe_1');

    expect(created.id).toMatch(/^txa_/);
    expect(trail).toEqual([created]);
    expect(trail[0]?.details.metadata).toEqual({ certificate: 'CERT-1' });
  });
});

describe('compliance status and deadlines', () => {
  const config = (registrations: { country: string; type: string; number: string; status: 'active' | 'inactive' | 'pending' }[]) =>
    repos.configurations.createConfiguration({
      name: `config ${registrations.length}`,
      status: 'active',
      isDefault: true,
      businessDetails: {
        businessName: 'Acme',
        address: { line1: 'x', city: 'x', state: 'x', country: 'US', postalCode: '1' },
        registrations,
      },
    });

  it('is compliant when nothing requires registration', async () => {
    expect(await reporting.validateComplianceStatus()).toEqual({ status: 'compliant', issues: [] });
  });

  it('is non-compliant when a jurisdiction requires registration and none is stored, then follows the registration', async () => {
    await repos.jurisdictions.createJurisdiction({
      name: 'Germany',
      code: 'DE',
      type: 'country',
      countryCode: 'DE',
      registrationRequired: true,
      filingFrequency: 'quarterly',
    });

    const missing = await reporting.validateComplianceStatus();
    expect(missing.status).toBe('non_compliant');
    expect(missing.issues).toEqual([
      expect.objectContaining({ type: 'missing_registration', jurisdiction: 'DE', severity: 'critical' }),
    ]);

    const pending = await config([{ country: 'DE', type: 'vat', number: 'DE123456789', status: 'pending' }]);
    const compliance = await reporting.validateComplianceStatus();
    expect(compliance.status).toBe('warning');

    orThrow(await repos.configurations.updateConfiguration(pending.id, {
      businessDetails: {
        businessName: 'Acme',
        address: { line1: 'x', city: 'x', state: 'x', country: 'US', postalCode: '1' },
        registrations: [{ country: 'DE', type: 'vat', number: 'DE123456789', status: 'active' }],
      },
    }));
    expect(await reporting.validateComplianceStatus()).toEqual({ status: 'compliant', issues: [] });
  });

  it('lists the next filing deadline of a registered jurisdiction: the end of the month after the quarter closes', async () => {
    const deadlines = await reporting.getUpcomingDeadlines(instant('2033-10-14T00:00:00Z'));

    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toMatchObject({ jurisdiction: 'Germany', type: 'Quarterly filing', priority: 'medium' });
    // Q3 closed on 30 September; the deadline is 31 October
    expect(deadlines[0]?.deadline.toString()).toBe('2033-10-31T23:59:59.999Z');
    const next = await reporting.getUpcomingDeadlines(instant('2033-11-01T00:00:00Z'));
    expect(next[0]?.deadline.toString()).toBe('2034-01-31T23:59:59.999Z');
  });

  // The frequency is free text in the jurisdiction row: an Object.prototype name once made the loop run forever
  it('skips a jurisdiction whose filing frequency is named like an object member', async () => {
    await repos.jurisdictions.createJurisdiction({
      name: 'Germany (odd row)',
      code: 'DE-X',
      type: 'country',
      countryCode: 'DE',
      registrationRequired: true,
      filingFrequency: 'constructor',
    });

    const deadlines = await reporting.getUpcomingDeadlines(instant('2033-10-14T00:00:00Z'));
    expect(deadlines.map(deadline => deadline.jurisdiction)).toEqual(['Germany']);
  }, 10_000);
});
