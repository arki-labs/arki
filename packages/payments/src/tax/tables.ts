import type { AnyPgColumn, PgSchema } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { boolean, jsonb, text, varchar } from 'drizzle-orm/pg-core';

import { instant } from '@arki/db/temporal';

import type {
  ExemptionStatus,
  ExemptionType,
  JurisdictionType,
  TaxBusinessType,
  TaxCalculationMode,
  TaxConfigStatus,
} from './primitives.js';
import {
  exemptionStatusValues,
  exemptionTypeValues,
  jurisdictionTypeValues,
  taxBusinessTypeValues,
  taxCalculationModeValues,
  taxConfigIdFactory,
  taxConfigStatusValues,
  taxExemptionIdFactory,
  taxJurisdictionIdFactory,
} from './primitives.js';

export type CreateTaxTablesDeps = {
  schema: PgSchema;
};

export function createTaxTables({ schema }: CreateTaxTablesDeps) {
  const taxConfigStatusEnum = schema.enum('tax_config_status', taxConfigStatusValues);
  const taxCalculationModeEnum = schema.enum('tax_calculation_mode', taxCalculationModeValues);
  const taxBusinessTypeEnum = schema.enum('tax_business_type', taxBusinessTypeValues);
  const jurisdictionTypeEnum = schema.enum('jurisdiction_type', jurisdictionTypeValues);
  const exemptionTypeEnum = schema.enum('exemption_type', exemptionTypeValues);
  const exemptionStatusEnum = schema.enum('exemption_status', exemptionStatusValues);

  const taxConfigurations = schema.table('tax_configurations', {
    id: taxConfigIdFactory.primaryColumn(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    status: taxConfigStatusEnum('status').$type<TaxConfigStatus>().notNull().default('active'),
    calculationMode: taxCalculationModeEnum('calculation_mode')
      .$type<TaxCalculationMode>()
      .notNull()
      .default('automatic'),
    businessType: taxBusinessTypeEnum('business_type').$type<TaxBusinessType>().notNull().default('saas'),
    defaultTaxCode: varchar('default_tax_code', { length: 50 }).notNull().default('txcd_10103000'),
    provider: varchar('provider', { length: 50 }).notNull().default('stripe'),
    providerSettings: jsonb('provider_settings').$type<{
      stripeSettings?: {
        calculateTaxAutomatically: boolean;
        taxIdCollection: boolean;
        useStripeTax: boolean;
      };
    }>(),
    businessDetails: jsonb('business_details').$type<{
      businessName: string;
      taxId?: string;
      address: {
        line1: string;
        line2?: string;
        city: string;
        state: string;
        country: string;
        postalCode: string;
      };
      registrations?: {
        country: string;
        type: string;
        number: string;
        status: 'active' | 'inactive' | 'pending';
      }[];
    }>(),
    taxRules: jsonb('tax_rules').$type<{
      exemptions?: {
        country: string;
        reason: string;
        taxCode?: string;
      }[];
      overrides?: {
        country: string;
        state?: string;
        rate: number;
        description: string;
      }[];
      thresholds?: {
        country: string;
        amount: number;
        currency: string;
        description: string;
      }[];
    }>(),
    features: jsonb('features').$type<{
      collectTaxIds: boolean;
      issueInvoices: boolean;
      trackExemptions: boolean;
      generateReports: boolean;
      reverseChargeHandling: boolean;
      crossBorderCompliance: boolean;
    }>(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: instant('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: instant('updated_at')
      .notNull()
      .default(sql`now()`),
    createdBy: varchar('created_by', { length: 255 }),
    updatedBy: varchar('updated_by', { length: 255 }),
  });

  const taxJurisdictions = schema.table('tax_jurisdictions', {
    id: taxJurisdictionIdFactory.primaryColumn(),
    name: varchar('name', { length: 255 }).notNull(),
    code: varchar('code', { length: 20 }).notNull(),
    type: jurisdictionTypeEnum('type').$type<JurisdictionType>().notNull(),
    parentId: taxJurisdictionIdFactory.optionalForeignKey('parent_id', (): AnyPgColumn => taxJurisdictions.id),
    countryCode: varchar('country_code', { length: 2 }).notNull(),
    stateCode: varchar('state_code', { length: 10 }),
    standardRate: varchar('standard_rate', { length: 10 }),
    reducedRates: jsonb('reduced_rates').$type<
      {
        rate: string;
        description: string;
        applicableTo: string[];
      }[]
    >(),
    taxIdRequired: boolean('tax_id_required').notNull().default(false),
    registrationRequired: boolean('registration_required').notNull().default(false),
    filingFrequency: varchar('filing_frequency', { length: 50 }),
    isActive: boolean('is_active').notNull().default(true),
    effectiveFrom: instant('effective_from'),
    effectiveTo: instant('effective_to'),
    createdAt: instant('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: instant('updated_at')
      .notNull()
      .default(sql`now()`),
  });

  const taxExemptions = schema.table('tax_exemptions', {
    id: taxExemptionIdFactory.primaryColumn(),
    type: exemptionTypeEnum('type').$type<ExemptionType>().notNull(),
    status: exemptionStatusEnum('status').$type<ExemptionStatus>().notNull().default('active'),
    customerId: varchar('customer_id', { length: 255 }),
    productCode: varchar('product_code', { length: 100 }),
    jurisdictionId: taxJurisdictionIdFactory.optionalForeignKey('jurisdiction_id', () => taxJurisdictions.id),
    exemptionCode: varchar('exemption_code', { length: 50 }).notNull(),
    reason: text('reason').notNull(),
    certificateNumber: varchar('certificate_number', { length: 100 }),
    validFrom: instant('valid_from').notNull(),
    validTo: instant('valid_to'),
    documents: jsonb('documents').$type<
      {
        type: string;
        url: string;
        uploadedAt: string;
        expiresAt?: string;
      }[]
    >(),
    createdAt: instant('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: instant('updated_at')
      .notNull()
      .default(sql`now()`),
    createdBy: varchar('created_by', { length: 255 }),
    approvedBy: varchar('approved_by', { length: 255 }),
    approvedAt: instant('approved_at'),
  });

  const taxConfigForeignKeys = taxConfigIdFactory.createForeignKeyFactory(() => taxConfigurations.id);
  const taxJurisdictionForeignKeys = taxJurisdictionIdFactory.createForeignKeyFactory(() => taxJurisdictions.id);
  const taxExemptionForeignKeys = taxExemptionIdFactory.createForeignKeyFactory(() => taxExemptions.id);

  return {
    enums: {
      taxConfigStatusEnum,
      taxCalculationModeEnum,
      taxBusinessTypeEnum,
      jurisdictionTypeEnum,
      exemptionTypeEnum,
      exemptionStatusEnum,
    },
    taxConfigurations,
    taxJurisdictions,
    taxExemptions,
    foreignKeys: {
      taxConfigForeignKeys,
      taxJurisdictionForeignKeys,
      taxExemptionForeignKeys,
    },
  };
}

export type TaxTables = ReturnType<typeof createTaxTables>;
