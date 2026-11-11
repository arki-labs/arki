import { z } from '@arki/contracts';
import { isBefore } from '@arki/date';
import { instantSchema } from '@arki/date/zod';
import { currencyCodeSchema } from '@arki/money/zod';

import type { TaxComplianceReport } from './reporting.js';
import type { TaxCalculationResult, TaxService } from './service.js';
import { moneyJsonSchema, positiveMoneySchema } from '../core/money.js';
import { holdsLoneSurrogate, MAX_BATCH_ITEMS, pgInstantSchema, pgJsonSchema, pgTextSchema as pgText, pgVarcharSchema as pgVarchar } from '../core/pg-values.js';
import {
  exemptionStatusValues,
  exemptionTypeValues,
  jurisdictionTypeValues,
  taxAuditActionValues,
  taxAuditEntityValues,
  taxBusinessTypeValues,
  taxCalculationModeValues,
  taxConfigIdSchema,
  taxConfigStatusValues,
  taxAuditEntryIdSchema,
  taxExemptionIdSchema,
  taxJurisdictionIdSchema,
  taxPlanIntervalValues,
  taxRecordIdSchema,
  taxRecordTypeValues,
} from './primitives.js';

// Enum schemas
export const taxConfigStatusSchema = z.enum(taxConfigStatusValues);
export const taxCalculationModeSchema = z.enum(taxCalculationModeValues);
export const taxBusinessTypeSchema = z.enum(taxBusinessTypeValues);
export const jurisdictionTypeSchema = z.enum(jurisdictionTypeValues);
export const exemptionTypeSchema = z.enum(exemptionTypeValues);
export const exemptionStatusSchema = z.enum(exemptionStatusValues);

// Tax configuration
export const createTaxConfigSchema = z.object({
  name: pgVarchar(255).min(1),
  description: pgText.optional(),
  calculationMode: taxCalculationModeSchema.default('automatic'),
  businessType: taxBusinessTypeSchema.default('saas'),
  defaultTaxCode: pgVarchar(50).default('txcd_10103000'),
  provider: pgVarchar(50).default('stripe'),
  providerSettings: z
    .object({
      stripeSettings: z
        .object({
          calculateTaxAutomatically: z.boolean().default(true),
          taxIdCollection: z.boolean().default(false),
          useStripeTax: z.boolean().default(true),
        })
        .optional(),
    })
    .optional(),
  businessDetails: z.object({
    businessName: pgText.min(1),
    taxId: pgText.optional(),
    address: z.object({
      line1: pgText.min(1),
      line2: pgText.optional(),
      city: pgText.min(1),
      state: pgText.min(1),
      country: pgText.length(2),
      postalCode: pgText.min(1),
    }),
    registrations: z
      .array(
        z.object({
          country: pgText.length(2),
          type: pgText,
          number: pgText,
          status: z.enum(['active', 'inactive', 'pending']),
        }),
      )
      .max(MAX_BATCH_ITEMS)
      .optional(),
  }),
  features: z
    .object({
      collectTaxIds: z.boolean().default(false),
      issueInvoices: z.boolean().default(false),
      trackExemptions: z.boolean().default(false),
      generateReports: z.boolean().default(false),
      reverseChargeHandling: z.boolean().default(false),
      crossBorderCompliance: z.boolean().default(false),
    })
    .optional(),
});

export const updateTaxConfigSchema = createTaxConfigSchema.partial().omit({ name: true });

export const updateConfigurationInputSchema = z.object({
  id: taxConfigIdSchema,
  data: updateTaxConfigSchema,
});

export const setDefaultConfigurationInputSchema = z.object({
  id: taxConfigIdSchema,
});

// Tax jurisdiction

/** A tax rate in percent, as a decimal string: `'19'`, `'7.5'`. Never negative, never above 100. */
export const taxRateSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'A tax rate is a non-negative decimal number')
  .refine(rate => Number(rate) <= 100, 'A tax rate is at most 100');

export const createJurisdictionSchema = z.object({
  name: pgVarchar(255).min(1),
  code: pgVarchar(20),
  type: jurisdictionTypeSchema,
  parentId: taxJurisdictionIdSchema.optional(),
  countryCode: pgText.length(2),
  stateCode: pgVarchar(10).optional(),
  /** The column holds 10 characters */
  standardRate: taxRateSchema.max(10).optional(),
  reducedRates: z
    .array(
      z.object({
        rate: taxRateSchema,
        description: pgText,
        applicableTo: z.array(pgText).max(MAX_BATCH_ITEMS),
      }),
    )
    .max(MAX_BATCH_ITEMS)
    .optional(),
  taxIdRequired: z.boolean().default(false),
  registrationRequired: z.boolean().default(false),
  filingFrequency: pgVarchar(50).optional(),
  effectiveFrom: pgInstantSchema().optional(),
  effectiveTo: pgInstantSchema().optional(),
});

export const getJurisdictionsByCountryInputSchema = z.object({
  countryCode: pgText.length(2),
});

export const getJurisdictionHierarchyInputSchema = z.object({
  id: taxJurisdictionIdSchema,
});

// Tax exemption
const exemptionTargetIssue = {
  path: ['customerId'],
  message: 'An exemption needs a customer, a product code or a jurisdiction: with none it would exempt every sale',
};

/**
 * What an exemption covers. It must name a customer, a product code or a jurisdiction: with none it
 * would exempt every sale. `TaxExemptionRepository.createExemption` checks every new row with it.
 */
export const exemptionTargetSchema = z
  .object({
    customerId: z.string().nullish(),
    productCode: z.string().nullish(),
    jurisdictionId: z.string().nullish(),
  })
  .refine(
    target => Boolean(target.customerId) || Boolean(target.productCode) || Boolean(target.jurisdictionId),
    exemptionTargetIssue,
  );

/**
 * When an exemption applies: it must not end before it starts (`validTo` may equal `validFrom`; no
 * `validTo` means it never ends). `TaxExemptionRepository` checks every new and updated row with it.
 */
export const exemptionPeriodSchema = z
  .object({ validFrom: instantSchema(), validTo: instantSchema().nullish() })
  .refine(period => period.validTo == null || !isBefore(period.validTo, period.validFrom), {
    path: ['validTo'],
    message: 'validTo must not be before validFrom',
  });

export const createExemptionSchema = z
  .object({
  type: exemptionTypeSchema,
  customerId: pgVarchar(255).optional(),
  productCode: pgVarchar(100).optional(),
  jurisdictionId: taxJurisdictionIdSchema.optional(),
  exemptionCode: pgVarchar(50),
  reason: pgText.min(1),
  certificateNumber: pgVarchar(100).optional(),
  validFrom: pgInstantSchema(),
  validTo: pgInstantSchema().optional(),
  documents: z
    .array(
      z.object({
        type: pgText,
        url: pgText.pipe(z.url()),
        uploadedAt: pgText,
        expiresAt: pgText.optional(),
      }),
    )
    .max(MAX_BATCH_ITEMS)
    .optional(),
  })
  .refine(exemption => exemptionTargetSchema.safeParse(exemption).success, exemptionTargetIssue)
  .refine(exemption => exemptionPeriodSchema.safeParse(exemption).success, {
    path: ['validTo'],
    message: 'validTo must not be before validFrom',
  });

export const getCustomerExemptionsInputSchema = z.object({
  customerId: pgText,
});

export const getExpiringExemptionsInputSchema = z.object({
  days: z.number().int().min(1).max(365).default(30),
});

export const approveExemptionInputSchema = z.object({
  id: taxExemptionIdSchema,
});

export const revokeExemptionInputSchema = z.object({
  id: taxExemptionIdSchema,
});

// What each table can store. The tax repositories check every row they write with one of these, so a
// value a column would refuse (U+0000 in text or JSON, text over the column's length, a bigint in JSON,
// a rate `numeric(8,4)` cannot hold, a negative tax amount, an id with U+0000 or over 256 characters, a time
// outside the years 1 to 9999 in any time column) returns `InvalidInput` (`schema.invalid_input`) and nothing
// is written, never a raw Postgres error.

/** A row's own id: the id schema, and what the `varchar(256)` id column can store (no U+0000). */
function storedId<S extends z.ZodType<string>>(schema: S) {
  return schema.refine(value => pgVarchar(256).safeParse(value).success, 'An id holds at most 256 characters and no U+0000');
}

/** A `tax_configurations` row. `TaxConfigurationRepository` checks inserts with it, updates with `.partial()`. */
export const taxConfigurationRowSchema = z.object({
  id: storedId(taxConfigIdSchema).optional(),
  name: pgVarchar(255),
  description: pgText.nullish(),
  status: taxConfigStatusSchema.optional(),
  calculationMode: taxCalculationModeSchema.optional(),
  businessType: taxBusinessTypeSchema.optional(),
  defaultTaxCode: pgVarchar(50).optional(),
  provider: pgVarchar(50).optional(),
  providerSettings: pgJsonSchema.optional(),
  businessDetails: pgJsonSchema.optional(),
  taxRules: pgJsonSchema.optional(),
  features: pgJsonSchema.optional(),
  createdBy: pgVarchar(255).nullish(),
  updatedBy: pgVarchar(255).nullish(),
  createdAt: pgInstantSchema().optional(),
  updatedAt: pgInstantSchema().optional(),
});

/** A `tax_jurisdictions` row. `TaxJurisdictionRepository` checks inserts with it, updates with `.partial()`. */
export const taxJurisdictionRowSchema = z.object({
  id: storedId(taxJurisdictionIdSchema).optional(),
  name: pgVarchar(255),
  type: jurisdictionTypeSchema.optional(),
  code: pgVarchar(20),
  countryCode: pgVarchar(2),
  stateCode: pgVarchar(10).nullish(),
  standardRate: pgVarchar(10).nullish(),
  reducedRates: pgJsonSchema.optional(),
  filingFrequency: pgVarchar(50).nullish(),
  effectiveFrom: pgInstantSchema().nullish(),
  effectiveTo: pgInstantSchema().nullish(),
  createdAt: pgInstantSchema().optional(),
  updatedAt: pgInstantSchema().optional(),
});

/** A `tax_exemptions` row. `TaxExemptionRepository` checks inserts with it, updates and approvals with `.partial()`. */
export const taxExemptionRowSchema = z.object({
  id: storedId(taxExemptionIdSchema).optional(),
  type: exemptionTypeSchema.optional(),
  status: exemptionStatusSchema.optional(),
  customerId: pgVarchar(255).nullish(),
  productCode: pgVarchar(100).nullish(),
  exemptionCode: pgVarchar(50),
  reason: pgText,
  certificateNumber: pgVarchar(100).nullish(),
  validFrom: pgInstantSchema(),
  validTo: pgInstantSchema().nullish(),
  documents: pgJsonSchema.optional(),
  createdBy: pgVarchar(255).nullish(),
  approvedBy: pgVarchar(255).nullish(),
  approvedAt: pgInstantSchema().nullish(),
  createdAt: pgInstantSchema().optional(),
  updatedAt: pgInstantSchema().optional(),
});

/** A `tax_audit_entries` row. `TaxAuditRepository.record` checks every entry with it. */
export const taxAuditRowSchema = z.object({
  id: storedId(taxAuditEntryIdSchema).optional(),
  action: z.enum(taxAuditActionValues),
  entity: z.enum(taxAuditEntityValues),
  entityId: pgVarchar(255),
  details: pgJsonSchema,
  occurredAt: pgInstantSchema().optional(),
});

/** A `tax_records` row. `TaxRecordRepository.recordMany` checks every row with it, and `createTaxTransaction` before it asks the provider. */
export const taxRecordRowSchema = z.object({
  id: storedId(taxRecordIdSchema).optional(),
  type: z.enum(taxRecordTypeValues),
  reference: pgVarchar(255),
  jurisdiction: pgVarchar(255),
  /** Percent as decimal text; the column is `numeric(8,4)`, so 10000 or more cannot be stored */
  rate: z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'A tax rate is a non-negative decimal number')
    .refine(rate => Number(rate) <= 9999.9999, 'A stored tax rate is at most 9999.9999'),
  /** Collected or given back, `type` says which: never negative */
  taxAmountMinor: z.number().int().min(0),
  /** ISO 4217: the reports read the amounts back as `Money` */
  currency: currencyCodeSchema,
  taxCode: pgVarchar(50).nullish(),
  customerId: pgVarchar(255).nullish(),
  paymentId: pgVarchar(255).nullish(),
  subscriptionId: pgVarchar(255).nullish(),
  providerTransactionId: pgVarchar(255).nullish(),
  occurredAt: pgInstantSchema().optional(),
});

/** The batch `TaxRecordRepository.recordMany` and `createTaxTransaction` write: at most `MAX_BATCH_ITEMS` (1,000) rows. */
export const taxRecordRowsSchema = z.array(taxRecordRowSchema).max(MAX_BATCH_ITEMS);

// Tax calculation

/** A sale's line items share its currency: one in another currency cannot be added to the rest. */
/** Text the tax provider (Stripe) takes: it refuses a lone surrogate (such as `'\ud800'`) as an invalid request. */
const providerText = z.string().refine(value => !holdsLoneSurrogate(value), 'Text cannot contain a lone surrogate (such as U+D800 alone)');

/** The text of a line item that goes to the tax provider. */
export const taxLineTextSchema = z.object({
  description: providerText,
  reference: providerText,
  taxCode: providerText.optional(),
  planId: providerText.optional(),
});

/** A customer's address and tax ids as the tax provider takes them. */
export const taxCustomerDetailsSchema = z.object({
  address: z
    .object({
      line1: providerText.optional(),
      line2: providerText.optional(),
      city: providerText.optional(),
      state: providerText.optional(),
      postalCode: providerText.optional(),
      country: providerText.optional(),
    })
    .optional(),
  taxIds: z
    .array(
      z.object({
        type: providerText,
        value: providerText,
      }),
    )
    .max(MAX_BATCH_ITEMS)
    .optional(),
});

/** At most `MAX_BATCH_ITEMS` (1,000) line items; every line item is in the sale's currency. */
export const taxCalculationInputSchema = z
  .object({
  customerId: pgText,
  lineItems: z
    .array(
      taxLineTextSchema.extend({
        /** In `currency` */
        amount: positiveMoneySchema,
      }),
    )
    .max(MAX_BATCH_ITEMS),
  currency: z.string().length(3).toUpperCase(),
  customerDetails: taxCustomerDetailsSchema.optional(),
  })
  .refine(input => input.lineItems.every(item => item.amount.currency.code === input.currency), {
    path: ['lineItems'],
    message: 'Every line item must be in the currency of the sale',
  });

export const calculateSubscriptionTaxInputSchema = z.object({
  customerId: pgText,
  planAmount: positiveMoneySchema,
  planInterval: z.enum(taxPlanIntervalValues),
  taxCode: z.string().optional(),
  customerDetails: taxCustomerDetailsSchema.optional(),
});

export const taxIdValidationSchema = z.object({
  type: z.string(),
  value: z.string(),
  country: z.string().length(2),
});

export const getCustomerTaxSummaryInputSchema = z.object({
  customerId: pgText,
  year: z.number().int().min(2000).max(2100),
});

// Reporting & compliance
export const generateComplianceReportInputSchema = z.object({
  reportType: z.enum(['sales_and_use_tax', 'vat', 'gst']),
  year: z.number().int().min(2000).max(2100),
  quarter: z.number().int().min(1).max(4).optional(),
  month: z.number().int().min(1).max(12).optional(),
  jurisdiction: pgText.optional(),
});

export const exportTaxDataInputSchema = z.object({
  format: z.enum(['csv', 'json', 'xml']),
  year: z.number().int().min(2000).max(2100),
  quarter: z.number().int().min(1).max(4).optional(),
  month: z.number().int().min(1).max(12).optional(),
  includeExemptions: z.boolean().default(false),
});

export const getCustomerAnnualSummaryInputSchema = z.object({
  customerId: pgText,
  year: z.number().int().min(2000).max(2100),
});

// Responses. Amounts go out as `Money` JSON (`{ amount: '19.99', currency: 'EUR' }`), so each
// schema below says what the wire holds and the RPC client's type matches it. A handler turns
// the service's `Money` values into that form with the `*Json` function next to the schema.

const reportTypeSchema = z.enum(['sales_and_use_tax', 'vat', 'gst']);

/** What `calculateTax` and `calculateSubscriptionTax` answer. */
export const taxCalculationResultSchema = z.object({
  subtotal: moneyJsonSchema,
  taxAmount: moneyJsonSchema,
  total: moneyJsonSchema,
  taxInclusive: z.boolean(),
  breakdown: z.array(
    z.object({
      jurisdiction: z.string(),
      rate: z.number(),
      amount: moneyJsonSchema,
      taxCode: z.string().optional(),
    }),
  ),
  applicableTaxIds: z.array(z.string()),
  /** The exemptions that kept tax off this sale, in whole or in part. */
  appliedExemptionIds: z.array(taxExemptionIdSchema),
});

export function taxCalculationResultJson(result: TaxCalculationResult): z.input<typeof taxCalculationResultSchema> {
  return {
    ...result,
    subtotal: result.subtotal.toJSON(),
    taxAmount: result.taxAmount.toJSON(),
    total: result.total.toJSON(),
    breakdown: result.breakdown.map(line => ({ ...line, amount: line.amount.toJSON() })),
  };
}

/** What `TaxService.getCustomerTaxSummary` answers. */
export const customerTaxSummarySchema = z.object({
  /** One total per currency, ordered by currency code */
  totalTaxPaid: z.array(moneyJsonSchema),
  totalTransactions: z.number(),
  breakdown: z.array(
    z.object({
      jurisdiction: z.string(),
      taxAmount: moneyJsonSchema,
      transactionCount: z.number(),
    }),
  ),
});

export function customerTaxSummaryJson(
  summary: Awaited<ReturnType<TaxService['getCustomerTaxSummary']>>,
): z.input<typeof customerTaxSummarySchema> {
  return {
    ...summary,
    totalTaxPaid: summary.totalTaxPaid.map(total => total.toJSON()),
    breakdown: summary.breakdown.map(line => ({ ...line, taxAmount: line.taxAmount.toJSON() })),
  };
}

/** What `generateComplianceReport` answers. */
export const taxComplianceReportSchema = z.object({
  id: z.string(),
  reportType: reportTypeSchema,
  period: z.object({
    year: z.number(),
    quarter: z.number().optional(),
    month: z.number().optional(),
    startDate: instantSchema(),
    endDate: instantSchema(),
  }),
  jurisdiction: z.string(),
  totalSales: z.array(moneyJsonSchema),
  totalTaxCollected: z.array(moneyJsonSchema),
  exemptSales: z.array(moneyJsonSchema),
  transactions: z.number(),
  generatedAt: instantSchema(),
  summary: z.object({
    taxableTransactions: z.number(),
    exemptTransactions: z.number(),
    averageTaxRate: z.number(),
    topTaxCategories: z.array(z.object({ category: z.string(), sales: moneyJsonSchema, tax: moneyJsonSchema })),
  }),
});

export function taxComplianceReportJson(report: TaxComplianceReport): z.input<typeof taxComplianceReportSchema> {
  return {
    ...report,
    totalSales: report.totalSales.map(total => total.toJSON()),
    totalTaxCollected: report.totalTaxCollected.map(total => total.toJSON()),
    exemptSales: report.exemptSales.map(total => total.toJSON()),
    summary: {
      ...report.summary,
      topTaxCategories: report.summary.topTaxCategories.map(category => ({
        ...category,
        sales: category.sales.toJSON(),
        tax: category.tax.toJSON(),
      })),
    },
  };
}

// Inferred type exports
export type CreateTaxConfig = z.infer<typeof createTaxConfigSchema>;
export type UpdateTaxConfig = z.infer<typeof updateTaxConfigSchema>;
export type UpdateConfigurationInput = z.infer<typeof updateConfigurationInputSchema>;
export type SetDefaultConfigurationInput = z.infer<typeof setDefaultConfigurationInputSchema>;

export type CreateJurisdiction = z.infer<typeof createJurisdictionSchema>;
export type GetJurisdictionsByCountryInput = z.infer<typeof getJurisdictionsByCountryInputSchema>;
export type GetJurisdictionHierarchyInput = z.infer<typeof getJurisdictionHierarchyInputSchema>;

export type CreateExemption = z.infer<typeof createExemptionSchema>;
export type GetCustomerExemptionsInput = z.infer<typeof getCustomerExemptionsInputSchema>;
export type GetExpiringExemptionsInput = z.infer<typeof getExpiringExemptionsInputSchema>;
export type ApproveExemptionInput = z.infer<typeof approveExemptionInputSchema>;
export type RevokeExemptionInput = z.infer<typeof revokeExemptionInputSchema>;

export type TaxCalculationInput = z.infer<typeof taxCalculationInputSchema>;
export type CalculateSubscriptionTaxInput = z.infer<typeof calculateSubscriptionTaxInputSchema>;
export type TaxIdValidation = z.infer<typeof taxIdValidationSchema>;
export type GetCustomerTaxSummaryInput = z.infer<typeof getCustomerTaxSummaryInputSchema>;

export type GenerateComplianceReportInput = z.infer<typeof generateComplianceReportInputSchema>;
export type ExportTaxDataInput = z.infer<typeof exportTaxDataInputSchema>;
export type GetCustomerAnnualSummaryInput = z.infer<typeof getCustomerAnnualSummaryInputSchema>;
