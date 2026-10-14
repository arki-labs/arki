import { createIdFactory } from '@arki/db/id-factory';

export type TaxConfigId = `txc_${string}`;
export type TaxJurisdictionId = `txj_${string}`;
export type TaxExemptionId = `txe_${string}`;
export type TaxRecordId = `txr_${string}`;
export type TaxAuditEntryId = `txa_${string}`;

const taxConfigId = createIdFactory<'txc_', TaxConfigId>('txc_');
const taxJurisdictionId = createIdFactory<'txj_', TaxJurisdictionId>('txj_');
const taxExemptionId = createIdFactory<'txe_', TaxExemptionId>('txe_');
const taxRecordId = createIdFactory<'txr_', TaxRecordId>('txr_');
const taxAuditEntryId = createIdFactory<'txa_', TaxAuditEntryId>('txa_');

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
