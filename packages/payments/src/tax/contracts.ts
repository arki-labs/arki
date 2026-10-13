import { z } from '@arki/contracts';

import { positiveMoneySchema } from '../core/money';
import {
  exemptionStatusValues,
  exemptionTypeValues,
  jurisdictionTypeValues,
  taxBusinessTypeValues,
  taxCalculationModeValues,
  taxConfigIdSchema,
  taxConfigStatusValues,
  taxExemptionIdSchema,
  taxJurisdictionIdSchema,
} from './primitives';

// Enum schemas
export const taxConfigStatusSchema = z.enum(taxConfigStatusValues);
export const taxCalculationModeSchema = z.enum(taxCalculationModeValues);
export const taxBusinessTypeSchema = z.enum(taxBusinessTypeValues);
export const jurisdictionTypeSchema = z.enum(jurisdictionTypeValues);
export const exemptionTypeSchema = z.enum(exemptionTypeValues);
export const exemptionStatusSchema = z.enum(exemptionStatusValues);

// Tax configuration
export const createTaxConfigSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  calculationMode: taxCalculationModeSchema.default('automatic'),
  businessType: taxBusinessTypeSchema.default('saas'),
  defaultTaxCode: z.string().max(50).default('txcd_10103000'),
  provider: z.string().max(50).default('stripe'),
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
    businessName: z.string().min(1),
    taxId: z.string().optional(),
    address: z.object({
      line1: z.string().min(1),
      line2: z.string().optional(),
      city: z.string().min(1),
      state: z.string().min(1),
      country: z.string().length(2),
      postalCode: z.string().min(1),
    }),
    registrations: z
      .array(
        z.object({
          country: z.string().length(2),
          type: z.string(),
          number: z.string(),
          status: z.enum(['active', 'inactive', 'pending']),
        }),
      )
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
export const createJurisdictionSchema = z.object({
  name: z.string().min(1).max(255),
  code: z.string().max(20),
  type: jurisdictionTypeSchema,
  parentId: taxJurisdictionIdSchema.optional(),
  countryCode: z.string().length(2),
  stateCode: z.string().max(10).optional(),
  standardRate: z.string().optional(),
  reducedRates: z
    .array(
      z.object({
        rate: z.string(),
        description: z.string(),
        applicableTo: z.array(z.string()),
      }),
    )
    .optional(),
  taxIdRequired: z.boolean().default(false),
  registrationRequired: z.boolean().default(false),
  filingFrequency: z.string().max(50).optional(),
  effectiveFrom: z.date().optional(),
  effectiveTo: z.date().optional(),
});

export const getJurisdictionsByCountryInputSchema = z.object({
  countryCode: z.string().length(2),
});

export const getJurisdictionHierarchyInputSchema = z.object({
  id: taxJurisdictionIdSchema,
});

// Tax exemption
export const createExemptionSchema = z.object({
  type: exemptionTypeSchema,
  customerId: z.string().max(255).optional(),
  productCode: z.string().max(100).optional(),
  jurisdictionId: taxJurisdictionIdSchema.optional(),
  exemptionCode: z.string().max(50),
  reason: z.string().min(1),
  certificateNumber: z.string().max(100).optional(),
  validFrom: z.date(),
  validTo: z.date().optional(),
  documents: z
    .array(
      z.object({
        type: z.string(),
        url: z.url(),
        uploadedAt: z.string(),
        expiresAt: z.string().optional(),
      }),
    )
    .optional(),
});

export const getCustomerExemptionsInputSchema = z.object({
  customerId: z.string(),
});

export const getExpiringExemptionsInputSchema = z.object({
  days: z.number().min(1).max(365).default(30),
});

export const approveExemptionInputSchema = z.object({
  id: taxExemptionIdSchema,
});

export const revokeExemptionInputSchema = z.object({
  id: taxExemptionIdSchema,
});

// Tax calculation
export const taxCalculationInputSchema = z.object({
  customerId: z.string(),
  lineItems: z.array(
    z.object({
      /** In `currency` */
      amount: positiveMoneySchema,
      description: z.string(),
      reference: z.string(),
      taxCode: z.string().optional(),
      planId: z.string().optional(),
    }),
  ),
  currency: z.string().length(3).toUpperCase(),
  customerDetails: z
    .object({
      address: z
        .object({
          line1: z.string().optional(),
          line2: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          postalCode: z.string().optional(),
          country: z.string().optional(),
        })
        .optional(),
      taxIds: z
        .array(
          z.object({
            type: z.string(),
            value: z.string(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export const calculateSubscriptionTaxInputSchema = z.object({
  customerId: z.string(),
  planAmount: positiveMoneySchema,
  planInterval: z.enum(['monthly', 'yearly']),
  taxCode: z.string().optional(),
  customerDetails: taxCalculationInputSchema.shape.customerDetails.optional(),
});

export const taxIdValidationSchema = z.object({
  type: z.string(),
  value: z.string(),
  country: z.string().length(2),
});

export const generateTaxReportInputSchema = z.object({
  reportType: z.enum(['sales_and_use_tax', 'vat', 'gst']),
  startDate: z.date(),
  endDate: z.date(),
  jurisdiction: z.string().optional(),
});

export const getCustomerTaxSummaryInputSchema = z.object({
  customerId: z.string(),
  year: z.number().min(2000).max(2100),
});

// Reporting & compliance
export const generateComplianceReportInputSchema = z.object({
  reportType: z.enum(['sales_and_use_tax', 'vat', 'gst']),
  year: z.number().min(2000).max(2100),
  quarter: z.number().min(1).max(4).optional(),
  month: z.number().min(1).max(12).optional(),
  jurisdiction: z.string().optional(),
});

export const exportTaxDataInputSchema = z.object({
  format: z.enum(['csv', 'json', 'xml']),
  year: z.number().min(2000).max(2100),
  quarter: z.number().min(1).max(4).optional(),
  month: z.number().min(1).max(12).optional(),
  includeExemptions: z.boolean().default(false),
});

export const getCustomerAnnualSummaryInputSchema = z.object({
  customerId: z.string(),
  year: z.number().min(2000).max(2100),
});

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
export type GenerateTaxReportInput = z.infer<typeof generateTaxReportInputSchema>;
export type GetCustomerTaxSummaryInput = z.infer<typeof getCustomerTaxSummaryInputSchema>;

export type GenerateComplianceReportInput = z.infer<typeof generateComplianceReportInputSchema>;
export type ExportTaxDataInput = z.infer<typeof exportTaxDataInputSchema>;
export type GetCustomerAnnualSummaryInput = z.infer<typeof getCustomerAnnualSummaryInputSchema>;
