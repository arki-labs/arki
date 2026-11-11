import type { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { pgSchema } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { expect } from 'vitest';

import { fromDate, instant } from '@arki/date';
import { orThrow } from '@arki/failure';
import { money } from '@arki/money';

import type { NewTaxConfig, NewTaxExemption, NewTaxJurisdiction, NewTaxRecord } from '../tax/types.js';
import type { AppDb } from '../test-support.js';
import { createCustomerId, createPaymentId, createSubscriptionId } from '../core/primitives.js';
import { createFakeStripeHttp, stripeProviderOf } from '../core/providers/stripe-test-support.js';
import { PaymentRepository } from '../core/repository.js';
import { runnerOn } from '../service-test-support.js';
import { customerTaxSummaryJson, taxCalculationResultJson, taxComplianceReportJson } from '../tax/contracts.js';
import {
  createTaxAuditEntryId,
  createTaxConfigId,
  createTaxExemptionId,
  createTaxJurisdictionId,
  createTaxRecordId,
} from '../tax/primitives.js';
import { createTaxReportingService, TaxReportingService } from '../tax/reporting.js';
import {
  createTaxRepositories,
  TaxAuditRepository,
  TaxConfigurationRepository,
  TaxExemptionRepository,
  TaxJurisdictionRepository,
  TaxRecordRepository,
} from '../tax/repository.js';
import { createTaxService, jurisdictionOwnsLine, TaxService } from '../tax/service.js';
import { createTaxTables } from '../tax/tables.js';
import { checkTaxIdFormat } from '../tax/tax-id.js';
import { adminId, core, customerId, openDb, schema, typed, userId } from '../test-support.js';
import { area, args, op } from './engine.js';

const tax = createTaxTables({ schema });

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

type Ctx = {
  db: AppDb;
  client: PGlite;
  repos: ReturnType<typeof createTaxRepositories>;
  service: TaxService;
  reporting: TaxReportingService;
  writes: ReturnType<typeof typed.core.writes>;
};

const noArgs = (): [] => [];

/** The result as the wire shows it: a `Money` is `{ amount, currency }`, an `Instant` its text. */
const wire = (value: unknown): unknown => {
  const text = JSON.stringify(value);
  return JSON.parse(text);
};

let counter = 0;
const nextNumber = () => {
  counter += 1;
  return counter;
};

const list = (data: unknown[]) => ({ object: 'list', url: '/v1/x', has_more: false, data });

/** Stripe on the fake HTTP layer: a calculation in the asked currency, the tax settings, and recorded transactions. */
function stripeAnswer(request: { path: string; form: Record<string, string> }) {
  if (request.path === '/v1/tax/calculations') {
    return {
      body: {
        id: 'taxcalc_1',
        object: 'tax.calculation',
        currency: request.form.currency ?? 'usd',
        amount_total: 11_900,
        tax_amount_exclusive: 1900,
        tax_amount_inclusive: 0,
        line_items: { data: [] },
      },
    };
  }
  if (request.path === '/v1/tax/settings') {
    return {
      body: {
        object: 'tax.settings',
        defaults: { tax_code: 'txcd_20030000' },
        head_office: { address: { country: 'DE', city: 'Berlin', postal_code: '10115', line1: null, state: null } },
      },
    };
  }
  if (request.path === '/v1/tax/registrations') return { body: list([]) };

  return {
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
  };
}

function stripeProvider() {
  const http = createFakeStripeHttp(stripeAnswer);
  return stripeProviderOf(
    { apiKey: 'sk_test_fake', webhookSecret: 'whsec_fake', environment: 'sandbox' },
    {
      references: {
        findCustomerById: id =>
          Promise.resolve({
            id,
            userId: 'usr_buyer',
            providerCustomerId: 'cus_test',
            provider: 'stripe',
            email: 'buyer@example.com',
            name: null,
            defaultPaymentMethodId: null,
            metadata: null,
            createdAt: instant('2026-01-01T00:00:00Z'),
            updatedAt: instant('2026-01-01T00:00:00Z'),
          }),
        findPlanById: () => Promise.resolve(null),
        findSubscriptionById: () => Promise.resolve(null),
        findPaymentById: () => Promise.resolve(null),
      },
      httpClient: http.client,
      maxNetworkRetries: 0,
    },
  );
}

// ---------------------------------------------------------------- valid data

const thisYear = new Date().getUTCFullYear();
const thisYearPeriod = () => ({
  year: thisYear,
  startDate: instant(`${thisYear}-01-01T00:00:00Z`),
  endDate: instant(`${thisYear + 1}-01-01T00:00:00Z`),
});
const period2031 = () => ({ start: instant('2031-01-01T00:00:00Z'), end: instant('2031-12-31T23:59:59Z') });

const newConfig = (): NewTaxConfig => ({
  name: `config ${nextNumber()}`,
  description: 'Main configuration',
  calculationMode: 'automatic',
  businessType: 'saas',
  defaultTaxCode: 'txcd_10103000',
  provider: 'stripe',
  createdBy: 'usr_admin',
  providerSettings: { stripeSettings: { calculateTaxAutomatically: true, taxIdCollection: false, useStripeTax: true } },
  businessDetails: {
    businessName: 'Acme GmbH',
    taxId: 'DE123456789',
    address: { line1: 'Main 1', city: 'Berlin', state: 'BE', country: 'DE', postalCode: '10115' },
    registrations: [{ country: 'DE', type: 'vat', number: 'DE123456789', status: 'active' }],
  },
});

const newJurisdiction = (overrides: Partial<NewTaxJurisdiction> = {}): NewTaxJurisdiction => ({
  name: `Germany ${nextNumber()}`,
  code: `J${counter}`,
  type: 'country',
  countryCode: 'DE',
  stateCode: 'BE',
  standardRate: '19',
  reducedRates: [{ rate: '7', description: 'Food', applicableTo: ['food'] }],
  filingFrequency: 'quarterly',
  effectiveFrom: instant('2020-01-01T00:00:00Z'),
  ...overrides,
});

const newExemption = (overrides: Partial<NewTaxExemption> = {}): NewTaxExemption => ({
  type: 'customer',
  status: 'active',
  customerId: orThrow(createCustomerId()),
  exemptionCode: 'NONPROFIT',
  reason: 'Registered charity',
  certificateNumber: 'CERT-1',
  validFrom: instant('2020-01-01T00:00:00Z'),
  validTo: instant('2099-01-01T00:00:00Z'),
  documents: [
    { type: 'certificate', url: 'https://example.com/cert.pdf', uploadedAt: '2020-01-01', expiresAt: '2099-01-01' },
  ],
  ...overrides,
});

const newRecord = (overrides: Partial<NewTaxRecord> = {}): NewTaxRecord => ({
  reference: `ref_${nextNumber()}`,
  type: 'sale',
  jurisdiction: `Germany ${counter}`,
  rate: '19',
  taxAmountMinor: 1900,
  currency: 'EUR',
  taxCode: 'txcd_10103000',
  customerId: `cus_${counter}`,
  paymentId: `pay_${counter}`,
  subscriptionId: `sub_${counter}`,
  providerTransactionId: `tax_txn_${counter}`,
  occurredAt: instant('2031-03-10T12:00:00Z'),
  ...overrides,
});

const calculationInput = () => ({
  customerId: orThrow(createCustomerId()),
  currency: 'USD',
  lineItems: [
    {
      amount: money('100', 'USD'),
      description: 'Pro',
      reference: 'line_1',
      taxCode: 'txcd_10103000',
      planId: 'plan_pro',
    },
  ],
  customerDetails: {
    address: { line1: 'Main 1', line2: 'Floor 2', city: 'Berlin', state: 'BE', postalCode: '10115', country: 'DE' },
    taxIds: [{ type: 'eu_vat', value: 'DE123456789' }],
  },
});

const transactionInput = () => ({
  reference: `txn_${nextNumber()}`,
  type: 'sale' as const,
  customerId: orThrow(createCustomerId()),
  paymentId: orThrow(createPaymentId()),
  subscriptionId: orThrow(createSubscriptionId()),
  lineItems: [{ amount: money('100', 'EUR'), description: 'Pro', reference: 'line_1', taxCode: 'txcd_10103000' }],
  currency: 'EUR',
  customerDetails: { address: { line1: 'Main 1', city: 'Berlin', postalCode: '10115', country: 'DE' } },
  breakdown: [{ jurisdiction: 'Germany', rate: 19, amount: money('19', 'EUR') }],
  occurredAt: instant('2031-03-10T12:00:00Z'),
});

/** A succeeded payment of 119 EUR with its 19 EUR of recorded tax, dated now: the report year is this year. */
async function seedTaxedPayment(ctx: Ctx) {
  const number = nextNumber();
  const created = orThrow(
    await ctx.writes.initiatePayment({
      userId,
      customerId,
      providerPaymentId: `pi_tax_fuzz_${number}`,
      amount: { amount: '119', currency: 'EUR' },
      description: 'Pro plan',
    }),
  );
  orThrow(await ctx.writes.completePayment({ paymentId: created.id }));
  orThrow(
    await ctx.repos.records.recordMany([
      newRecord({ jurisdiction: 'Germany', paymentId: created.id, customerId, occurredAt: fromDate(new Date()) }),
    ]),
  );

  return created.id;
}

export const taxArea = area<Ctx>({
  area: 'tax',
  async open() {
    const opened = await openDb({
      ...tax.enums,
      taxJurisdictions: tax.taxJurisdictions,
      taxExemptions: tax.taxExemptions,
      taxConfigurations: tax.taxConfigurations,
      taxRecords: tax.taxRecords,
      taxAuditEntries: tax.taxAuditEntries,
    });
    const db = drizzle({ client: opened.client, relations });
    const repos = createTaxRepositories(db, tax);
    return {
      db: opened.db,
      client: opened.client,
      repos,
      service: new TaxService(stripeProvider(), repos),
      reporting: createTaxReportingService({ payments: new PaymentRepository(db, core), ...repos }),
      writes: typed.core.writes(runnerOn(opened.db)),
    };
  },
  close: ctx => ctx.client.close(),
  cases: [
    // ------------------------------------------------------------ primitives
    op('tax/primitives.ts::createTaxConfigId', { arrange: noArgs, call: () => createTaxConfigId() }),
    op('tax/primitives.ts::createTaxJurisdictionId', { arrange: noArgs, call: () => createTaxJurisdictionId() }),
    op('tax/primitives.ts::createTaxExemptionId', { arrange: noArgs, call: () => createTaxExemptionId() }),
    op('tax/primitives.ts::createTaxRecordId', { arrange: noArgs, call: () => createTaxRecordId() }),
    op('tax/primitives.ts::createTaxAuditEntryId', { arrange: noArgs, call: () => createTaxAuditEntryId() }),

    // ------------------------------------------------------------ tax id, tables
    op('tax/tax-id.ts::checkTaxIdFormat', {
      arrange: () => args({ type: 'eu_vat', value: 'DE123456789', country: 'DE' }),
      call: (_ctx, taxId) => checkTaxIdFormat(taxId),
      valid: result => expect(result).toEqual({ format: 'valid' }),
    }),
    op('tax/tables.ts::createTaxTables', {
      arrange: () => args({ schema: pgSchema(`fuzz_${nextNumber()}`) }),
      call: (_ctx, deps) => createTaxTables(deps),
      valid: result =>
        expect(result).toMatchObject({ taxRecords: expect.anything(), taxConfigurations: expect.anything() }),
      keep: { 'args[0].schema': 'a drizzle schema, a dependency' },
    }),

    // ------------------------------------------------------------ contracts
    op('tax/contracts.ts::taxCalculationResultJson', {
      arrange: () =>
        args({
          subtotal: money('100', 'USD'),
          taxAmount: money('19', 'USD'),
          total: money('119', 'USD'),
          taxInclusive: false,
          breakdown: [{ jurisdiction: 'Germany', rate: 19, amount: money('19', 'USD'), taxCode: 'txcd_10103000' }],
          applicableTaxIds: ['eu_vat'],
          appliedExemptionIds: [orThrow(createTaxExemptionId())],
        }),
      call: (_ctx, result) => taxCalculationResultJson(result),
      valid: result => expect(result).toMatchObject({ total: { amount: '119.00', currency: 'USD' } }),
    }),
    op('tax/contracts.ts::customerTaxSummaryJson', {
      arrange: () =>
        args({
          totalTaxPaid: [money('19', 'EUR')],
          totalTransactions: 1,
          breakdown: [{ jurisdiction: 'Germany', taxAmount: money('19', 'EUR'), transactionCount: 1 }],
        }),
      call: (_ctx, summary) => customerTaxSummaryJson(summary),
      valid: result =>
        expect(result).toMatchObject({ totalTaxPaid: [{ amount: '19.00', currency: 'EUR' }], totalTransactions: 1 }),
    }),
    op('tax/contracts.ts::taxComplianceReportJson', {
      arrange: () =>
        args({
          id: 'vat:all:2031',
          reportType: 'vat' as const,
          period: thisYearPeriod(),
          jurisdiction: 'all',
          totalSales: [money('119', 'EUR')],
          totalTaxCollected: [money('19', 'EUR')],
          exemptSales: [money('0', 'EUR')],
          transactions: 1,
          generatedAt: instant('2031-01-01T00:00:00Z'),
          summary: {
            taxableTransactions: 1,
            exemptTransactions: 0,
            averageTaxRate: 0.19,
            topTaxCategories: [{ category: 'One-time payments', sales: money('119', 'EUR'), tax: money('19', 'EUR') }],
          },
        }),
      call: (_ctx, report) => taxComplianceReportJson(report),
      valid: result =>
        expect(result).toMatchObject({ id: 'vat:all:2031', totalTaxCollected: [{ amount: '19.00', currency: 'EUR' }] }),
    }),

    // ------------------------------------------------------------ constructors and factory of the repositories
    op('tax/repository.ts::TaxConfigurationRepository', {
      arrange: ctx => args(ctx.db, { taxConfigurations: tax.taxConfigurations }),
      call: (_ctx, db, tables) => new TaxConfigurationRepository(db, tables),
      valid: result => expect(result).toBeInstanceOf(TaxConfigurationRepository),
      keep: { 'args[1]': 'the tables, a dependency' },
    }),
    op('tax/repository.ts::TaxJurisdictionRepository', {
      arrange: ctx => args(ctx.db, { taxJurisdictions: tax.taxJurisdictions, taxExemptions: tax.taxExemptions }),
      call: (_ctx, db, tables) => new TaxJurisdictionRepository(db, tables),
      valid: result => expect(result).toBeInstanceOf(TaxJurisdictionRepository),
      keep: { 'args[1]': 'the tables, a dependency' },
    }),
    op('tax/repository.ts::TaxExemptionRepository', {
      arrange: ctx => args(ctx.db, { taxExemptions: tax.taxExemptions, taxJurisdictions: tax.taxJurisdictions }),
      call: (_ctx, db, tables) => new TaxExemptionRepository(db, tables),
      valid: result => expect(result).toBeInstanceOf(TaxExemptionRepository),
      keep: { 'args[1]': 'the tables, a dependency' },
    }),
    op('tax/repository.ts::TaxAuditRepository', {
      arrange: ctx => args(ctx.db, { taxAuditEntries: tax.taxAuditEntries }),
      call: (_ctx, db, tables) => new TaxAuditRepository(db, tables),
      valid: result => expect(result).toBeInstanceOf(TaxAuditRepository),
      keep: { 'args[1]': 'the tables, a dependency' },
    }),
    op('tax/repository.ts::TaxRecordRepository', {
      arrange: ctx => args(ctx.db, { taxRecords: tax.taxRecords }),
      call: (_ctx, db, tables) => new TaxRecordRepository(db, tables),
      valid: result => expect(result).toBeInstanceOf(TaxRecordRepository),
      keep: { 'args[1]': 'the tables, a dependency' },
    }),
    op('tax/repository.ts::createTaxRepositories', {
      arrange: ctx => args(ctx.db, tax),
      call: (_ctx, db, tables) => createTaxRepositories(db, tables),
      valid: result => expect(result).toMatchObject({ records: expect.any(TaxRecordRepository) }),
      keep: { 'args[1]': 'the tables, a dependency' },
    }),

    // ------------------------------------------------------------ configurations
    op('tax/repository.ts::TaxConfigurationRepository.createConfiguration', {
      arrange: () => args(newConfig()),
      call: (ctx, data) => ctx.repos.configurations.createConfiguration(data),
      valid: result => expect(result).toMatchObject({ description: 'Main configuration', provider: 'stripe' }),
    }),
    op('tax/repository.ts::TaxConfigurationRepository.findConfigurationById', {
      arrange: async ctx => args(orThrow(await ctx.repos.configurations.createConfiguration(newConfig())).id),
      call: (ctx, id) => ctx.repos.configurations.findConfigurationById(id),
      valid: result => expect(result).toMatchObject({ provider: 'stripe' }),
    }),
    op('tax/repository.ts::TaxConfigurationRepository.findDefaultConfiguration', {
      arrange: async ctx => {
        const config = orThrow(await ctx.repos.configurations.createConfiguration(newConfig()));
        orThrow(await ctx.repos.configurations.setDefaultConfiguration(config.id));
        return args();
      },
      call: (ctx, ..._none) => ctx.repos.configurations.findDefaultConfiguration(),
      valid: result => expect(result).toMatchObject({ isDefault: true }),
    }),
    op('tax/repository.ts::TaxConfigurationRepository.findActiveConfigurations', {
      arrange: async ctx => {
        orThrow(await ctx.repos.configurations.createConfiguration(newConfig()));
        return args();
      },
      call: (ctx, ..._none) => ctx.repos.configurations.findActiveConfigurations(),
      valid: result => expect(result).not.toHaveLength(0),
    }),
    op('tax/repository.ts::TaxConfigurationRepository.updateConfiguration', {
      arrange: async ctx =>
        args(orThrow(await ctx.repos.configurations.createConfiguration(newConfig())).id, {
          description: 'Changed',
          updatedBy: 'usr_admin',
        }),
      call: (ctx, id, data) => ctx.repos.configurations.updateConfiguration(id, data),
      valid: result => expect(result).toMatchObject({ description: 'Changed' }),
    }),
    op('tax/repository.ts::TaxConfigurationRepository.setDefaultConfiguration', {
      arrange: async ctx => args(orThrow(await ctx.repos.configurations.createConfiguration(newConfig())).id),
      call: (ctx, id) => ctx.repos.configurations.setDefaultConfiguration(id),
      valid: result => expect(result).toMatchObject({ isDefault: true }),
    }),
    op('tax/repository.ts::TaxConfigurationRepository.deleteConfiguration', {
      arrange: async ctx => args(orThrow(await ctx.repos.configurations.createConfiguration(newConfig())).id),
      call: (ctx, id) => ctx.repos.configurations.deleteConfiguration(id),
      valid: result => expect(result).toBeUndefined(),
    }),

    // ------------------------------------------------------------ jurisdictions
    op('tax/repository.ts::TaxJurisdictionRepository.createJurisdiction', {
      arrange: () => args(newJurisdiction()),
      call: (ctx, data) => ctx.repos.jurisdictions.createJurisdiction(data),
      valid: result => expect(result).toMatchObject({ countryCode: 'DE', standardRate: '19', isActive: true }),
    }),
    op('tax/repository.ts::TaxJurisdictionRepository.findJurisdictionById', {
      arrange: async ctx => args(orThrow(await ctx.repos.jurisdictions.createJurisdiction(newJurisdiction())).id),
      call: (ctx, id) => ctx.repos.jurisdictions.findJurisdictionById(id),
      valid: result => expect(result).toMatchObject({ countryCode: 'DE' }),
    }),
    op('tax/repository.ts::TaxJurisdictionRepository.findJurisdictionByCode', {
      arrange: async ctx => {
        const row = orThrow(await ctx.repos.jurisdictions.createJurisdiction(newJurisdiction()));
        return args(row.code, row.countryCode);
      },
      call: (ctx, code, countryCode) => ctx.repos.jurisdictions.findJurisdictionByCode(code, countryCode),
      valid: result => expect(result).toMatchObject({ countryCode: 'DE' }),
    }),
    op('tax/repository.ts::TaxJurisdictionRepository.findJurisdictionsByCountry', {
      arrange: async ctx => {
        orThrow(await ctx.repos.jurisdictions.createJurisdiction(newJurisdiction()));
        return args('DE');
      },
      call: (ctx, countryCode) => ctx.repos.jurisdictions.findJurisdictionsByCountry(countryCode),
      valid: result =>
        expect(Array.isArray(result) && result.length > 0 && result.every(row => row.countryCode === 'DE')).toBe(true),
    }),
    op('tax/repository.ts::TaxJurisdictionRepository.findActiveJurisdictions', {
      arrange: async ctx => {
        orThrow(await ctx.repos.jurisdictions.createJurisdiction(newJurisdiction()));
        return args();
      },
      call: (ctx, ..._none) => ctx.repos.jurisdictions.findActiveJurisdictions(),
      valid: result => expect(Array.isArray(result) && result.length > 0).toBe(true),
    }),
    op('tax/repository.ts::TaxJurisdictionRepository.findJurisdictionHierarchy', {
      arrange: async ctx => {
        const parent = orThrow(await ctx.repos.jurisdictions.createJurisdiction(newJurisdiction()));
        const child = orThrow(
          await ctx.repos.jurisdictions.createJurisdiction(newJurisdiction({ type: 'state', parentId: parent.id })),
        );
        return args(child.id);
      },
      call: (ctx, id) => ctx.repos.jurisdictions.findJurisdictionHierarchy(id),
      valid: result => expect(result).toHaveLength(2),
    }),
    op('tax/repository.ts::TaxJurisdictionRepository.updateJurisdiction', {
      arrange: async ctx =>
        args(orThrow(await ctx.repos.jurisdictions.createJurisdiction(newJurisdiction())).id, {
          name: 'Renamed',
          standardRate: '20',
        }),
      call: (ctx, id, data) => ctx.repos.jurisdictions.updateJurisdiction(id, data),
      valid: result => expect(result).toMatchObject({ name: 'Renamed', standardRate: '20' }),
    }),
    op('tax/repository.ts::TaxJurisdictionRepository.deleteJurisdiction', {
      arrange: async ctx => args(orThrow(await ctx.repos.jurisdictions.createJurisdiction(newJurisdiction())).id),
      call: (ctx, id) => ctx.repos.jurisdictions.deleteJurisdiction(id),
      valid: result => expect(result).toBeUndefined(),
    }),

    // ------------------------------------------------------------ exemptions
    op('tax/repository.ts::TaxExemptionRepository.createExemption', {
      arrange: () => args(newExemption()),
      call: (ctx, data) => ctx.repos.exemptions.createExemption(data),
      valid: result => expect(result).toMatchObject({ exemptionCode: 'NONPROFIT', status: 'active' }),
    }),
    op('tax/repository.ts::TaxExemptionRepository.findExemptionById', {
      arrange: async ctx => args(orThrow(await ctx.repos.exemptions.createExemption(newExemption())).id),
      call: (ctx, id) => ctx.repos.exemptions.findExemptionById(id),
      valid: result => expect(result).toMatchObject({ exemptionCode: 'NONPROFIT' }),
    }),
    op('tax/repository.ts::TaxExemptionRepository.findCustomerExemptions', {
      arrange: async ctx => {
        const row = orThrow(await ctx.repos.exemptions.createExemption(newExemption()));
        return args(row.customerId ?? '');
      },
      call: (ctx, customer) => ctx.repos.exemptions.findCustomerExemptions(customer),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('tax/repository.ts::TaxExemptionRepository.findCustomerExemptionsInRange', {
      arrange: async ctx => {
        const row = orThrow(await ctx.repos.exemptions.createExemption(newExemption()));
        return args(row.customerId ?? '', instant('2030-01-01T00:00:00Z'), instant('2030-12-31T00:00:00Z'));
      },
      call: (ctx, customer, start, end) => ctx.repos.exemptions.findCustomerExemptionsInRange(customer, start, end),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('tax/repository.ts::TaxExemptionRepository.findApplicableExemptions', {
      arrange: async ctx => {
        const row = orThrow(await ctx.repos.exemptions.createExemption(newExemption()));
        return args(row.customerId ?? '', instant('2030-06-01T00:00:00Z'));
      },
      call: (ctx, customer, at) => ctx.repos.exemptions.findApplicableExemptions(customer, at),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('tax/repository.ts::TaxExemptionRepository.findExemptionsInRange', {
      arrange: async ctx => {
        orThrow(await ctx.repos.exemptions.createExemption(newExemption()));
        return args(instant('2030-01-01T00:00:00Z'), instant('2030-12-31T00:00:00Z'));
      },
      call: (ctx, start, end) => ctx.repos.exemptions.findExemptionsInRange(start, end),
      valid: result => expect(Array.isArray(result) && result.length > 0).toBe(true),
    }),
    op('tax/repository.ts::TaxExemptionRepository.findProductExemptions', {
      arrange: async ctx => {
        const productCode = `txcd_${nextNumber()}`;
        orThrow(
          await ctx.repos.exemptions.createExemption(newExemption({ type: 'product', customerId: null, productCode })),
        );
        return args(productCode);
      },
      call: (ctx, productCode) => ctx.repos.exemptions.findProductExemptions(productCode),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('tax/repository.ts::TaxExemptionRepository.findJurisdictionExemptions', {
      arrange: async ctx => {
        const jurisdiction = orThrow(await ctx.repos.jurisdictions.createJurisdiction(newJurisdiction()));
        orThrow(
          await ctx.repos.exemptions.createExemption(
            newExemption({ type: 'jurisdiction', customerId: null, jurisdictionId: jurisdiction.id }),
          ),
        );
        return args(jurisdiction.id);
      },
      call: (ctx, id) => ctx.repos.exemptions.findJurisdictionExemptions(id),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('tax/repository.ts::TaxExemptionRepository.findExpiringExemptions', {
      arrange: async ctx => {
        orThrow(
          await ctx.repos.exemptions.createExemption(
            newExemption({ validTo: fromDate(new Date(Date.now() + 10 * 86_400_000)) }),
          ),
        );
        return args(30);
      },
      call: (ctx, days) => ctx.repos.exemptions.findExpiringExemptions(days),
      valid: result => expect(Array.isArray(result) && result.length > 0).toBe(true),
    }),
    op('tax/repository.ts::TaxExemptionRepository.updateExemption', {
      arrange: async ctx =>
        args(orThrow(await ctx.repos.exemptions.createExemption(newExemption())).id, {
          reason: 'Changed reason',
          certificateNumber: 'CERT-2',
        }),
      call: (ctx, id, data) => ctx.repos.exemptions.updateExemption(id, data),
      valid: result => expect(result).toMatchObject({ reason: 'Changed reason', certificateNumber: 'CERT-2' }),
    }),
    op('tax/repository.ts::TaxExemptionRepository.approveExemption', {
      arrange: async ctx =>
        args(
          orThrow(await ctx.repos.exemptions.createExemption(newExemption({ status: 'pending_review' }))).id,
          'usr_admin',
        ),
      call: (ctx, id, approvedBy) => ctx.repos.exemptions.approveExemption(id, approvedBy),
      valid: result => expect(result).toMatchObject({ status: 'active', approvedBy: 'usr_admin' }),
    }),
    op('tax/repository.ts::TaxExemptionRepository.revokeExemption', {
      arrange: async ctx => args(orThrow(await ctx.repos.exemptions.createExemption(newExemption())).id),
      call: (ctx, id) => ctx.repos.exemptions.revokeExemption(id),
      valid: result => expect(result).toMatchObject({ status: 'revoked' }),
    }),
    op('tax/repository.ts::TaxExemptionRepository.deleteExemption', {
      arrange: async ctx => args(orThrow(await ctx.repos.exemptions.createExemption(newExemption())).id),
      call: (ctx, id) => ctx.repos.exemptions.deleteExemption(id),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('tax/repository.ts::TaxExemptionRepository.getExemptionStats', {
      arrange: async ctx => {
        orThrow(await ctx.repos.exemptions.createExemption(newExemption()));
        return args();
      },
      call: (ctx, ..._none) => ctx.repos.exemptions.getExemptionStats(),
      valid: result => {
        expect(result).toMatchObject({ totalActive: expect.any(Number) });
        expect(result).not.toMatchObject({ totalActive: 0 });
      },
    }),

    // ------------------------------------------------------------ audit
    op('tax/repository.ts::TaxAuditRepository.record', {
      arrange: () =>
        args({
          action: 'calculate' as const,
          entity: 'payment' as const,
          entityId: `pay_${nextNumber()}`,
          details: { reason: 'checkout', userId: 'usr_buyer', metadata: { source: 'web' } },
        }),
      call: (ctx, entry) => ctx.repos.audit.record(entry),
      valid: result =>
        expect(result).toMatchObject({ action: 'calculate', entity: 'payment', details: { reason: 'checkout' } }),
    }),
    op('tax/repository.ts::TaxAuditRepository.findByEntity', {
      arrange: async ctx => {
        const entityId = `pay_${nextNumber()}`;
        orThrow(
          await ctx.repos.audit.record({
            action: 'calculate',
            entity: 'payment',
            entityId,
            details: { reason: 'checkout' },
          }),
        );
        return args('payment' as const, entityId);
      },
      call: (ctx, entity, entityId) => ctx.repos.audit.findByEntity(entity, entityId),
      valid: result => expect(result).toHaveLength(1),
    }),

    // ------------------------------------------------------------ records
    op('tax/repository.ts::TaxRecordRepository.recordMany', {
      arrange: () => args([newRecord()]),
      call: (ctx, rows) => ctx.repos.records.recordMany(rows),
      valid: result => expect(result).toBeUndefined(),
    }),
    op('tax/repository.ts::TaxRecordRepository.findByReference', {
      arrange: async ctx => {
        const row = newRecord();
        orThrow(await ctx.repos.records.recordMany([row]));
        return args('sale' as const, row.reference);
      },
      call: (ctx, type, reference) => ctx.repos.records.findByReference(type, reference),
      valid: result => expect(result).toHaveLength(1),
    }),
    op('tax/repository.ts::TaxRecordRepository.countSaleTransactions', {
      arrange: async ctx => {
        const row = newRecord();
        orThrow(await ctx.repos.records.recordMany([row]));
        return args({ ...period2031(), customerId: row.customerId ?? '', jurisdiction: row.jurisdiction });
      },
      call: (ctx, filter) => ctx.repos.records.countSaleTransactions(filter),
      valid: result => expect(result).toBe(1),
    }),
    op('tax/repository.ts::TaxRecordRepository.totalsByPayment', {
      arrange: async ctx => {
        const row = newRecord();
        orThrow(await ctx.repos.records.recordMany([row]));
        return args({ ...period2031(), jurisdiction: row.jurisdiction });
      },
      call: (ctx, filter) => ctx.repos.records.totalsByPayment(filter),
      valid: result => expect(result).toMatchObject([{ currency: 'EUR', saleTaxMinor: '1900', refundTaxMinor: '0' }]),
    }),
    op('tax/repository.ts::TaxRecordRepository.totalsByJurisdiction', {
      arrange: async ctx => {
        const row = newRecord();
        orThrow(await ctx.repos.records.recordMany([row]));
        return args({ ...period2031(), customerId: row.customerId ?? '', jurisdiction: row.jurisdiction });
      },
      call: (ctx, filter) => ctx.repos.records.totalsByJurisdiction(filter),
      valid: result => expect(result).toMatchObject([{ currency: 'EUR', saleTaxMinor: '1900', saleCount: 1 }]),
    }),

    // ------------------------------------------------------------ service
    op('tax/service.ts::TaxService', {
      arrange: ctx => args(stripeProvider(), ctx.repos),
      call: (_ctx, provider, reads) => new TaxService(provider, reads),
      valid: result => expect(result).toBeInstanceOf(TaxService),
      keep: { 'args[1]': 'the repositories, a dependency' },
    }),
    op('tax/service.ts::createTaxService', {
      arrange: ctx => args(stripeProvider(), ctx.repos),
      call: (_ctx, provider, reads) => createTaxService(provider, reads),
      valid: result => expect(result).toBeInstanceOf(TaxService),
      keep: { 'args[1]': 'the repositories, a dependency' },
    }),
    op('tax/service.ts::jurisdictionOwnsLine', {
      arrange: async ctx =>
        args(orThrow(await ctx.repos.jurisdictions.createJurisdiction(newJurisdiction())), {
          amount: money('19', 'USD'),
          rate: 19,
          jurisdiction: 'Germany',
          country: 'DE',
          level: 'country',
        }),
      call: (_ctx, jurisdiction, line) => jurisdictionOwnsLine(jurisdiction, line),
      valid: result => expect(result).toBe(true),
    }),
    op('tax/service.ts::TaxService.calculateTax', {
      arrange: () => args(calculationInput()),
      call: (ctx, input) => ctx.service.calculateTax(input),
      valid: result =>
        expect(wire(result)).toMatchObject({
          taxAmount: { amount: '19.00', currency: 'USD' },
          total: { amount: '119.00', currency: 'USD' },
        }),
    }),
    op('tax/service.ts::TaxService.createTaxTransaction', {
      arrange: () => args(transactionInput()),
      call: (ctx, params) => ctx.service.createTaxTransaction(params),
      valid: result => expect(wire(result)).toMatchObject({ taxAmount: { amount: '19.00', currency: 'EUR' } }),
    }),
    op('tax/service.ts::TaxService.getTaxSettings', {
      arrange: noArgs,
      call: (ctx, ..._none) => ctx.service.getTaxSettings(),
      valid: result => expect(wire(result)).toMatchObject({ defaultTaxCode: 'txcd_20030000' }),
    }),
    op('tax/service.ts::TaxService.calculateSubscriptionTax', {
      arrange: () =>
        args({
          customerId: orThrow(createCustomerId()),
          planAmount: money('100', 'USD'),
          planInterval: 'monthly' as const,
          taxCode: 'txcd_10103000',
          customerDetails: calculationInput().customerDetails,
        }),
      call: (ctx, params) => ctx.service.calculateSubscriptionTax(params),
      valid: result => expect(wire(result)).toMatchObject({ taxAmount: { amount: '19.00', currency: 'USD' } }),
    }),
    op('tax/service.ts::TaxService.calculateOneTimeTax', {
      arrange: () =>
        args({
          customerId: orThrow(createCustomerId()),
          amount: money('100', 'USD'),
          description: 'Donation',
          taxCode: 'txcd_10000000',
          customerDetails: calculationInput().customerDetails,
        }),
      call: (ctx, params) => ctx.service.calculateOneTimeTax(params),
      valid: result => expect(wire(result)).toMatchObject({ taxAmount: { amount: '19.00', currency: 'USD' } }),
    }),
    op('tax/service.ts::TaxService.validateTaxId', {
      arrange: () => args({ type: 'eu_vat', value: 'DE123456789', country: 'DE' }),
      call: (ctx, taxId) => ctx.service.validateTaxId(taxId),
      valid: result => expect(result).toEqual({ valid: true, format: 'valid', country: 'DE', type: 'eu_vat' }),
    }),
    op('tax/service.ts::TaxService.getCustomerTaxSummary', {
      arrange: async ctx => {
        const input = transactionInput();
        orThrow(await ctx.service.createTaxTransaction(input));
        return args({ customerId: input.customerId, year: 2031 });
      },
      call: (ctx, params) => ctx.service.getCustomerTaxSummary(params),
      valid: result =>
        expect(wire(result)).toMatchObject({
          totalTransactions: 1,
          totalTaxPaid: [{ amount: '19.00', currency: 'EUR' }],
        }),
    }),

    // ------------------------------------------------------------ reporting
    op('tax/reporting.ts::TaxReportingService', {
      arrange: ctx => args({ payments: new PaymentRepository(ctx.db, core), ...ctx.repos }),
      call: (_ctx, reads) => new TaxReportingService(reads),
      valid: result => expect(result).toBeInstanceOf(TaxReportingService),
      keep: { 'args[0]': 'the repositories, a dependency' },
    }),
    op('tax/reporting.ts::createTaxReportingService', {
      arrange: ctx => args({ payments: new PaymentRepository(ctx.db, core), ...ctx.repos }),
      call: (_ctx, reads) => createTaxReportingService(reads),
      valid: result => expect(result).toBeInstanceOf(TaxReportingService),
      keep: { 'args[0]': 'the repositories, a dependency' },
    }),
    op('tax/reporting.ts::TaxReportingService.generateComplianceReport', {
      arrange: async ctx => {
        await seedTaxedPayment(ctx);
        return args({ reportType: 'vat' as const, period: thisYearPeriod(), jurisdiction: 'Germany' });
      },
      call: (ctx, params) => ctx.reporting.generateComplianceReport(params),
      valid: result => {
        expect(wire(result)).toMatchObject({ jurisdiction: 'Germany', totalTaxCollected: [{ currency: 'EUR' }] });
        expect(wire(result)).not.toMatchObject({ transactions: 0 });
      },
    }),
    op('tax/reporting.ts::TaxReportingService.getCustomerTaxSummary', {
      arrange: async ctx => {
        await seedTaxedPayment(ctx);
        return args(customerId, thisYear);
      },
      call: (ctx, customer, year) => ctx.reporting.getCustomerTaxSummary(customer, year),
      valid: result => expect(wire(result)).not.toMatchObject({ transactions: [] }),
    }),
    op('tax/reporting.ts::TaxReportingService.createAuditEntry', {
      arrange: () =>
        args({
          action: 'apply' as const,
          entity: 'customer' as const,
          entityId: `cus_${nextNumber()}`,
          details: { reason: 'manual', userId: adminId, metadata: { source: 'admin' } },
        }),
      call: (ctx, entry) => ctx.reporting.createAuditEntry(entry),
      valid: result =>
        expect(wire(result)).toMatchObject({ action: 'apply', entity: 'customer', details: { reason: 'manual' } }),
    }),
    op('tax/reporting.ts::TaxReportingService.getAuditTrail', {
      arrange: async ctx => {
        const entityId = `cus_${nextNumber()}`;
        orThrow(
          await ctx.reporting.createAuditEntry({
            action: 'apply',
            entity: 'customer',
            entityId,
            details: { reason: 'manual' },
          }),
        );
        return args('customer' as const, entityId);
      },
      call: (ctx, entity, entityId) => ctx.reporting.getAuditTrail(entity, entityId),
      valid: result => expect(result).toMatchObject([{ action: 'apply', details: { reason: 'manual' } }]),
    }),
    op('tax/reporting.ts::TaxReportingService.getUpcomingDeadlines', {
      arrange: async ctx => {
        const config = orThrow(await ctx.repos.configurations.createConfiguration(newConfig()));
        orThrow(await ctx.repos.configurations.setDefaultConfiguration(config.id));
        const name = `Deadline land ${nextNumber()}`;
        orThrow(
          await ctx.repos.jurisdictions.createJurisdiction(
            newJurisdiction({ name, registrationRequired: true, filingFrequency: 'quarterly' }),
          ),
        );
        return args(instant('2031-01-15T00:00:00Z'));
      },
      call: (ctx, asOf) => ctx.reporting.getUpcomingDeadlines(asOf),
      valid: result =>
        expect(wire(result)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ description: expect.stringContaining('Quarterly tax filing for Deadline land') }),
          ]),
        ),
    }),
    op('tax/reporting.ts::TaxReportingService.validateComplianceStatus', {
      arrange: async ctx => {
        const config = orThrow(await ctx.repos.configurations.createConfiguration(newConfig()));
        orThrow(await ctx.repos.configurations.setDefaultConfiguration(config.id));
        return args();
      },
      call: (ctx, ..._none) => ctx.reporting.validateComplianceStatus(),
      valid: result =>
        expect(wire(result)).toMatchObject({ status: expect.stringMatching(/^(compliant|warning|non_compliant)$/) }),
    }),
    op('tax/reporting.ts::TaxReportingService.exportTaxData', {
      arrange: async ctx => {
        await seedTaxedPayment(ctx);
        return args({ format: 'csv' as const, period: thisYearPeriod(), includeExemptions: true });
      },
      call: (ctx, params) => ctx.reporting.exportTaxData(params),
      valid: result =>
        expect(wire(result)).toMatchObject({
          format: 'csv',
          filename: `tax_export_${thisYear}.csv`,
          data: expect.stringContaining('119'),
        }),
    }),
  ],
});
