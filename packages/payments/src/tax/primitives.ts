import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';

export type TaxConfigId = IdOf<typeof taxConfigId>;
export type TaxJurisdictionId = IdOf<typeof taxJurisdictionId>;
export type TaxExemptionId = IdOf<typeof taxExemptionId>;
export type TaxRecordId = IdOf<typeof taxRecordId>;
export type TaxAuditEntryId = IdOf<typeof taxAuditEntryId>;

const taxConfigId = defineId('txc_');
const taxJurisdictionId = defineId('txj_');
const taxExemptionId = defineId('txe_');
const taxRecordId = defineId('txr_');
const taxAuditEntryId = defineId('txa_');

export const createTaxConfigId = taxConfigId.create;
export const createTaxJurisdictionId = taxJurisdictionId.create;
export const createTaxExemptionId = taxExemptionId.create;
export const createTaxRecordId = taxRecordId.create;
export const createTaxAuditEntryId = taxAuditEntryId.create;

export const taxConfigIdSchema = taxConfigId.schema;
export const taxJurisdictionIdSchema = taxJurisdictionId.schema;
export const taxExemptionIdSchema = taxExemptionId.schema;

export const taxConfigIdFactory = taxConfigId;
export const taxJurisdictionIdFactory = taxJurisdictionId;
export const taxExemptionIdFactory = taxExemptionId;
export const taxRecordIdFactory = taxRecordId;
export const taxAuditEntryIdFactory = taxAuditEntryId;

export const taxConfigStatusValues = ['active', 'inactive', 'pending'] as const;
export const taxCalculationModeValues = ['automatic', 'manual', 'disabled'] as const;
export const taxBusinessTypeValues = ['saas', 'digital_goods', 'physical_goods', 'services', 'mixed'] as const;
export const jurisdictionTypeValues = ['country', 'state', 'province', 'city', 'county', 'district'] as const;
export const exemptionTypeValues = ['customer', 'product', 'jurisdiction', 'threshold'] as const;
export const exemptionStatusValues = ['active', 'expired', 'revoked', 'pending_review'] as const;

export const taxRecordTypeValues = ['sale', 'refund'] as const;

export type TaxRecordType = (typeof taxRecordTypeValues)[number];
export type TaxConfigStatus = (typeof taxConfigStatusValues)[number];
export type TaxCalculationMode = (typeof taxCalculationModeValues)[number];
export type TaxBusinessType = (typeof taxBusinessTypeValues)[number];
export type JurisdictionType = (typeof jurisdictionTypeValues)[number];
export type ExemptionType = (typeof exemptionTypeValues)[number];
export type ExemptionStatus = (typeof exemptionStatusValues)[number];
