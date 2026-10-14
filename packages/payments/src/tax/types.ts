import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

import type { TaxTables } from './tables.js';

export type TaxConfig = InferSelectModel<TaxTables['taxConfigurations']>;
export type NewTaxConfig = InferInsertModel<TaxTables['taxConfigurations']>;

export type TaxJurisdiction = InferSelectModel<TaxTables['taxJurisdictions']>;
export type NewTaxJurisdiction = InferInsertModel<TaxTables['taxJurisdictions']>;

export type TaxExemption = InferSelectModel<TaxTables['taxExemptions']>;
export type NewTaxExemption = InferInsertModel<TaxTables['taxExemptions']>;

export type TaxRecord = InferSelectModel<TaxTables['taxRecords']>;
export type NewTaxRecord = InferInsertModel<TaxTables['taxRecords']>;

export type TaxAuditRow = InferSelectModel<TaxTables['taxAuditEntries']>;
export type NewTaxAuditRow = InferInsertModel<TaxTables['taxAuditEntries']>;
