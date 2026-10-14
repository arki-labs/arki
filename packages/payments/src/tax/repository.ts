import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';

import type { Instant } from '@arki/date';
import { now } from '@arki/date';

import type { TaxConfigId, TaxExemptionId, TaxJurisdictionId, TaxRecordType } from './primitives.js';
import type { TaxTables } from './tables.js';
import type {
  NewTaxConfig,
  NewTaxExemption,
  NewTaxAuditRow,
  NewTaxJurisdiction,
  NewTaxRecord,
  TaxAuditRow,
  TaxConfig,
  TaxExemption,
  TaxJurisdiction,
  TaxRecord,
} from './types.js';

/**
 * Structural database type for the tax repositories. The tax repositories
 * only use `db.select / insert / update / delete` (no relational query
 * builder), so `AnyRelations` is sufficient — no host-side relations
 * contract is required beyond having the tax tables in the schema.
 */
export type TaxDatabase =
  | NodePgDatabase<AnyRelations>
  | NodePgTransaction<AnyRelations>
  | PgliteDatabase<AnyRelations>;

export type UpdateTaxConfiguration = Partial<Omit<NewTaxConfig, 'id'>>;
export type UpdateTaxJurisdiction = Partial<Omit<NewTaxJurisdiction, 'id'>>;
export type UpdateTaxExemption = Partial<Omit<NewTaxExemption, 'id'>>;

/**
 * Tax Configuration Repository
 * Manages global tax settings and configurations
 */
export class TaxConfigurationRepository {
  private readonly db: TaxDatabase;
  private readonly taxConfigurations: TaxTables['taxConfigurations'];

  constructor(db: TaxDatabase, tables: Pick<TaxTables, 'taxConfigurations'>) {
    this.db = db;
    this.taxConfigurations = tables.taxConfigurations;
  }

  async createConfiguration(data: NewTaxConfig): Promise<TaxConfig> {
    const result = await this.db.insert(this.taxConfigurations).values(data).returning();
    if (!result[0]) {
      throw new Error('Failed to create tax configuration');
    }
    return result[0] as TaxConfig;
  }

  async findConfigurationById(id: TaxConfigId): Promise<TaxConfig | null> {
    const results = await this.db
      .select()
      .from(this.taxConfigurations)
      .where(eq(this.taxConfigurations.id, id))
      .limit(1);
    return (results[0] as TaxConfig | undefined) ?? null;
  }

  async findDefaultConfiguration(): Promise<TaxConfig | null> {
    const results = await this.db
      .select()
      .from(this.taxConfigurations)
      .where(
        and(eq(this.taxConfigurations.isDefault, true), eq(this.taxConfigurations.status, 'active')),
      )
      .limit(1);
    return (results[0] as TaxConfig | undefined) ?? null;
  }

  async findActiveConfigurations(): Promise<TaxConfig[]> {
    return this.db
      .select()
      .from(this.taxConfigurations)
      .where(eq(this.taxConfigurations.status, 'active'))
      .orderBy(desc(this.taxConfigurations.isDefault), this.taxConfigurations.name) as Promise<TaxConfig[]>;
  }

  async updateConfiguration(id: TaxConfigId, data: UpdateTaxConfiguration): Promise<TaxConfig> {
    const result = await this.db
      .update(this.taxConfigurations)
      .set({ ...data, updatedAt: now() })
      .where(eq(this.taxConfigurations.id, id))
      .returning();
    if (!result[0]) {
      throw new Error('Failed to update tax configuration or configuration not found');
    }
    return result[0] as TaxConfig;
  }

  async setDefaultConfiguration(id: TaxConfigId): Promise<TaxConfig> {
    // First, remove default flag from all configurations
    await this.db
      .update(this.taxConfigurations)
      .set({ isDefault: false, updatedAt: now() })
      .where(eq(this.taxConfigurations.isDefault, true));

    // Then set the new default
    const result = await this.db
      .update(this.taxConfigurations)
      .set({ isDefault: true, updatedAt: now() })
      .where(eq(this.taxConfigurations.id, id))
      .returning();

    if (!result[0]) {
      throw new Error('Failed to set default tax configuration');
    }
    return result[0] as TaxConfig;
  }

  async deleteConfiguration(id: TaxConfigId): Promise<void> {
    await this.db.delete(this.taxConfigurations).where(eq(this.taxConfigurations.id, id));
  }
}

/**
 * Tax Jurisdiction Repository
 * Manages tax jurisdictions and their rates
 */
export class TaxJurisdictionRepository {
  private readonly db: TaxDatabase;
  private readonly taxJurisdictions: TaxTables['taxJurisdictions'];

  constructor(db: TaxDatabase, tables: Pick<TaxTables, 'taxJurisdictions'>) {
    this.db = db;
    this.taxJurisdictions = tables.taxJurisdictions;
  }

  async createJurisdiction(data: NewTaxJurisdiction): Promise<TaxJurisdiction> {
    const result = await this.db.insert(this.taxJurisdictions).values(data).returning();
    if (!result || !Array.isArray(result) || !result[0]) {
      throw new Error('Failed to create tax jurisdiction');
    }
    return result[0] as TaxJurisdiction;
  }

  async findJurisdictionById(id: TaxJurisdictionId): Promise<TaxJurisdiction | null> {
    const results = await this.db
      .select()
      .from(this.taxJurisdictions)
      .where(eq(this.taxJurisdictions.id, id))
      .limit(1);
    return (results[0] as TaxJurisdiction | undefined) ?? null;
  }

  async findJurisdictionByCode(code: string, countryCode: string): Promise<TaxJurisdiction | null> {
    const results = await this.db
      .select()
      .from(this.taxJurisdictions)
      .where(
        and(
          eq(this.taxJurisdictions.code, code),
          eq(this.taxJurisdictions.countryCode, countryCode),
        ),
      )
      .limit(1);
    return (results[0] as TaxJurisdiction | undefined) ?? null;
  }

  async findJurisdictionsByCountry(countryCode: string): Promise<TaxJurisdiction[]> {
    return this.db
      .select()
      .from(this.taxJurisdictions)
      .where(
        and(
          eq(this.taxJurisdictions.countryCode, countryCode),
          eq(this.taxJurisdictions.isActive, true),
        ),
      )
      .orderBy(this.taxJurisdictions.type, this.taxJurisdictions.name) as Promise<TaxJurisdiction[]>;
  }

  async findActiveJurisdictions(): Promise<TaxJurisdiction[]> {
    return this.db
      .select()
      .from(this.taxJurisdictions)
      .where(eq(this.taxJurisdictions.isActive, true))
      .orderBy(
        this.taxJurisdictions.countryCode,
        this.taxJurisdictions.type,
        this.taxJurisdictions.name,
      ) as Promise<TaxJurisdiction[]>;
  }

  async findJurisdictionHierarchy(id: TaxJurisdictionId): Promise<TaxJurisdiction[]> {
    // Get the jurisdiction and its parents
    const jurisdiction = await this.findJurisdictionById(id);
    if (!jurisdiction) return [];

    const hierarchy: TaxJurisdiction[] = [jurisdiction];

    // Walk up the parent chain
    let current: TaxJurisdiction | null = jurisdiction;
    const parentIdKey = 'parentId';
    while (current && parentIdKey in current && current[parentIdKey]) {
      const parentId = current[parentIdKey];
      const parent = await this.findJurisdictionById(parentId);
      if (!parent) break;
      hierarchy.unshift(parent); // Add to beginning
      current = parent;
    }

    return hierarchy;
  }

  async updateJurisdiction(
    id: TaxJurisdictionId,
    data: UpdateTaxJurisdiction,
  ): Promise<TaxJurisdiction> {
    const result = await this.db
      .update(this.taxJurisdictions)
      .set({ ...data, updatedAt: now() })
      .where(eq(this.taxJurisdictions.id, id))
      .returning();
    if (!result[0]) {
      throw new Error('Failed to update tax jurisdiction or jurisdiction not found');
    }
    return result[0] as TaxJurisdiction;
  }

  async deleteJurisdiction(id: TaxJurisdictionId): Promise<void> {
    await this.db.delete(this.taxJurisdictions).where(eq(this.taxJurisdictions.id, id));
  }
}

/**
 * Tax Exemption Repository
 * Manages tax exemptions for customers, products, and jurisdictions
 */
export class TaxExemptionRepository {
  private readonly db: TaxDatabase;
  private readonly taxExemptions: TaxTables['taxExemptions'];

  constructor(db: TaxDatabase, tables: Pick<TaxTables, 'taxExemptions'>) {
    this.db = db;
    this.taxExemptions = tables.taxExemptions;
  }

  async createExemption(data: NewTaxExemption): Promise<TaxExemption> {
    if (!data.customerId && !data.productCode && !data.jurisdictionId) {
      throw new Error('A tax exemption needs a customer, a product code or a jurisdiction');
    }
    const result = await this.db.insert(this.taxExemptions).values(data).returning();
    if (!result[0]) {
      throw new Error('Failed to create tax exemption');
    }
    return result[0] as TaxExemption;
  }

  async findExemptionById(id: TaxExemptionId): Promise<TaxExemption | null> {
    const results = await this.db
      .select()
      .from(this.taxExemptions)
      .where(eq(this.taxExemptions.id, id))
      .limit(1);
    return (results[0] as TaxExemption | undefined) ?? null;
  }

  async findCustomerExemptions(customerId: string): Promise<TaxExemption[]> {
    return this.db
      .select()
      .from(this.taxExemptions)
      .where(
        and(
          eq(this.taxExemptions.customerId, customerId),
          eq(this.taxExemptions.status, 'active'),
          // Check that exemption is currently valid
          sql`${this.taxExemptions.validFrom} <= NOW()`,
          sql`(${this.taxExemptions.validTo} IS NULL OR ${this.taxExemptions.validTo} > NOW())`,
        ),
      )
      .orderBy(this.taxExemptions.validFrom) as Promise<TaxExemption[]>;
  }

  /**
   * The customer's exemptions that were in force at some point between `start` and `end`,
   * both inclusive. Pending and revoked exemptions never applied, so they are left out.
   */
  async findCustomerExemptionsInRange(customerId: string, start: Instant, end: Instant): Promise<TaxExemption[]> {
    return this.db
      .select()
      .from(this.taxExemptions)
      .where(
        and(
          eq(this.taxExemptions.customerId, customerId),
          inArray(this.taxExemptions.status, ['active', 'expired']),
          lte(this.taxExemptions.validFrom, end),
          or(isNull(this.taxExemptions.validTo), gte(this.taxExemptions.validTo, start)),
        ),
      )
      .orderBy(this.taxExemptions.validFrom);
  }

  /**
   * The exemptions that can keep tax off a sale to `customerId` at `at`: active, in force, and
   * either the customer's own or open to every customer (no `customerId`). Pending, revoked and
   * expired ones never apply. `threshold` exemptions are left out: nothing stores a threshold
   * amount to test a sale against. The caller narrows by product and jurisdiction.
   */
  async findApplicableExemptions(customerId: string, at: Instant = now()): Promise<TaxExemption[]> {
    return this.db
      .select()
      .from(this.taxExemptions)
      .where(
        and(
          or(eq(this.taxExemptions.customerId, customerId), isNull(this.taxExemptions.customerId)),
          eq(this.taxExemptions.status, 'active'),
          ne(this.taxExemptions.type, 'threshold'),
          lte(this.taxExemptions.validFrom, at),
          or(isNull(this.taxExemptions.validTo), gt(this.taxExemptions.validTo, at)),
        ),
      )
      .orderBy(this.taxExemptions.validFrom, this.taxExemptions.id);
  }

  /** Every customer's exemptions that were in force at some point between `start` and `end`, both inclusive. Pending and revoked ones never applied. */
  async findExemptionsInRange(start: Instant, end: Instant): Promise<TaxExemption[]> {
    return this.db
      .select()
      .from(this.taxExemptions)
      .where(
        and(
          inArray(this.taxExemptions.status, ['active', 'expired']),
          lte(this.taxExemptions.validFrom, end),
          or(isNull(this.taxExemptions.validTo), gte(this.taxExemptions.validTo, start)),
        ),
      )
      .orderBy(this.taxExemptions.validFrom, this.taxExemptions.id);
  }

  async findProductExemptions(productCode: string): Promise<TaxExemption[]> {
    return this.db
      .select()
      .from(this.taxExemptions)
      .where(
        and(
          eq(this.taxExemptions.productCode, productCode),
          eq(this.taxExemptions.status, 'active'),
          sql`${this.taxExemptions.validFrom} <= NOW()`,
          sql`(${this.taxExemptions.validTo} IS NULL OR ${this.taxExemptions.validTo} > NOW())`,
        ),
      )
      .orderBy(this.taxExemptions.validFrom) as Promise<TaxExemption[]>;
  }

  async findJurisdictionExemptions(jurisdictionId: TaxJurisdictionId): Promise<TaxExemption[]> {
    return this.db
      .select()
      .from(this.taxExemptions)
      .where(
        and(
          eq(this.taxExemptions.jurisdictionId, jurisdictionId),
          eq(this.taxExemptions.status, 'active'),
          sql`${this.taxExemptions.validFrom} <= NOW()`,
          sql`(${this.taxExemptions.validTo} IS NULL OR ${this.taxExemptions.validTo} > NOW())`,
        ),
      )
      .orderBy(this.taxExemptions.validFrom) as Promise<TaxExemption[]>;
  }

  async findExpiringExemptions(days = 30): Promise<TaxExemption[]> {
    // Local-time calendar days, as before. The raw `sql` parameter below needs a string.
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);

    return this.db
      .select()
      .from(this.taxExemptions)
      .where(
        and(
          eq(this.taxExemptions.status, 'active'),
          sql`${this.taxExemptions.validTo} IS NOT NULL`,
          sql`${this.taxExemptions.validTo} <= ${futureDate.toISOString()}`,
          sql`${this.taxExemptions.validTo} > NOW()`,
        ),
      )
      .orderBy(this.taxExemptions.validTo) as Promise<TaxExemption[]>;
  }

  async updateExemption(id: TaxExemptionId, data: UpdateTaxExemption): Promise<TaxExemption> {
    const result = await this.db
      .update(this.taxExemptions)
      .set({ ...data, updatedAt: now() })
      .where(eq(this.taxExemptions.id, id))
      .returning();
    if (!result[0]) {
      throw new Error('Failed to update tax exemption or exemption not found');
    }
    return result[0] as TaxExemption;
  }

  async approveExemption(id: TaxExemptionId, approvedBy: string): Promise<TaxExemption> {
    const result = await this.db
      .update(this.taxExemptions)
      .set({
        status: 'active',
        approvedBy,
        approvedAt: now(),
        updatedAt: now(),
      })
      .where(eq(this.taxExemptions.id, id))
      .returning();
    if (!result[0]) {
      throw new Error('Failed to approve tax exemption');
    }
    return result[0] as TaxExemption;
  }

  async revokeExemption(id: TaxExemptionId): Promise<TaxExemption> {
    const result = await this.db
      .update(this.taxExemptions)
      .set({ status: 'revoked', updatedAt: now() })
      .where(eq(this.taxExemptions.id, id))
      .returning();
    if (!result[0]) {
      throw new Error('Failed to revoke tax exemption');
    }
    return result[0] as TaxExemption;
  }

  async deleteExemption(id: TaxExemptionId): Promise<void> {
    await this.db.delete(this.taxExemptions).where(eq(this.taxExemptions.id, id));
  }

  // Analytics and reporting methods
  async getExemptionStats(): Promise<{
    totalActive: number;
    totalPendingReview: number;
    totalExpired: number;
    totalRevoked: number;
    expiringNext30Days: number;
  }> {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);

    const [activeCount] = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(this.taxExemptions)
      .where(eq(this.taxExemptions.status, 'active'));

    const [pendingCount] = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(this.taxExemptions)
      .where(eq(this.taxExemptions.status, 'pending_review'));

    const [expiredCount] = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(this.taxExemptions)
      .where(eq(this.taxExemptions.status, 'expired'));

    const [revokedCount] = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(this.taxExemptions)
      .where(eq(this.taxExemptions.status, 'revoked'));

    const [expiringCount] = await this.db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(this.taxExemptions)
      .where(
        and(
          eq(this.taxExemptions.status, 'active'),
          sql`${this.taxExemptions.validTo} IS NOT NULL`,
          sql`${this.taxExemptions.validTo} <= ${futureDate.toISOString()}`,
          sql`${this.taxExemptions.validTo} > NOW()`,
        ),
      );

    return {
      totalActive: activeCount?.count || 0,
      totalPendingReview: pendingCount?.count || 0,
      totalExpired: expiredCount?.count || 0,
      totalRevoked: revokedCount?.count || 0,
      expiringNext30Days: expiringCount?.count || 0,
    };
  }
}

/**
 * Tax Audit Repository
 * The append-only trail of tax actions
 */
export class TaxAuditRepository {
  private readonly db: TaxDatabase;
  private readonly taxAuditEntries: TaxTables['taxAuditEntries'];

  constructor(db: TaxDatabase, tables: Pick<TaxTables, 'taxAuditEntries'>) {
    this.db = db;
    this.taxAuditEntries = tables.taxAuditEntries;
  }

  async record(entry: NewTaxAuditRow): Promise<TaxAuditRow> {
    const [row] = await this.db.insert(this.taxAuditEntries).values(entry).returning();
    if (!row) throw new Error('Failed to record tax audit entry');

    return row;
  }

  /** The entries about one entity, oldest first. */
  async findByEntity(entity: TaxAuditRow['entity'], entityId: string): Promise<TaxAuditRow[]> {
    return this.db
      .select()
      .from(this.taxAuditEntries)
      .where(and(eq(this.taxAuditEntries.entity, entity), eq(this.taxAuditEntries.entityId, entityId)))
      .orderBy(this.taxAuditEntries.occurredAt, this.taxAuditEntries.id);
  }
}

/** The tax in one jurisdiction and one currency over a period: collected on sales, given back on refunds. */
export type TaxRecordTotal = {
  jurisdiction: string;
  currency: string;
  saleTaxMinor: number;
  refundTaxMinor: number;
  /** Distinct sale transactions that carried tax here */
  saleCount: number;
  /** Distinct refund transactions that carried tax here */
  refundCount: number;
};

/**
 * Tax Record Repository
 * The per-jurisdiction tax of each recorded sale and refund
 */
export class TaxRecordRepository {
  private readonly db: TaxDatabase;
  private readonly taxRecords: TaxTables['taxRecords'];

  constructor(db: TaxDatabase, tables: Pick<TaxTables, 'taxRecords'>) {
    this.db = db;
    this.taxRecords = tables.taxRecords;
  }

  /** Write the rows. A row already recorded (same type, reference, jurisdiction and rate) is left as it was. */
  async recordMany(rows: NewTaxRecord[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(this.taxRecords).values(rows).onConflictDoNothing();
  }

  async findByReference(type: TaxRecordType, reference: string): Promise<TaxRecord[]> {
    return this.db
      .select()
      .from(this.taxRecords)
      .where(and(eq(this.taxRecords.type, type), eq(this.taxRecords.reference, reference)))
      .orderBy(this.taxRecords.jurisdiction, this.taxRecords.rate);
  }

  /** How many distinct sales carried tax between `start` and `end`, both inclusive (a sale taxed in two jurisdictions counts once). */
  async countSaleTransactions(period: { start: Instant; end: Instant; customerId?: string; jurisdiction?: string }): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(distinct ${this.taxRecords.reference})`.mapWith(Number) })
      .from(this.taxRecords)
      .where(
        and(
          eq(this.taxRecords.type, 'sale'),
          gte(this.taxRecords.occurredAt, period.start),
          lte(this.taxRecords.occurredAt, period.end),
          period.customerId === undefined ? undefined : eq(this.taxRecords.customerId, period.customerId),
          period.jurisdiction === undefined
            ? undefined
            : sql`lower(${this.taxRecords.jurisdiction}) = lower(${period.jurisdiction})`,
        ),
      );

    return row?.count ?? 0;
  }

  /**
   * The tax each payment carried, for the records that happened between `start` and `end`, both
   * inclusive. Records with no payment id are left out. `jurisdiction` limits it to one (any case).
   */
  async totalsByPayment(period: { start: Instant; end: Instant; jurisdiction?: string }): Promise<TaxRecordPaymentTotal[]> {
    const { type, taxAmountMinor } = this.taxRecords;

    return this.db
      .select({
        paymentId: sql<string>`${this.taxRecords.paymentId}`,
        currency: this.taxRecords.currency,
        saleTaxMinor: sql<number>`coalesce(sum(${taxAmountMinor}) filter (where ${type} = 'sale'), 0)`.mapWith(Number),
        refundTaxMinor: sql<number>`coalesce(sum(${taxAmountMinor}) filter (where ${type} = 'refund'), 0)`.mapWith(Number),
      })
      .from(this.taxRecords)
      .where(
        and(
          sql`${this.taxRecords.paymentId} IS NOT NULL`,
          gte(this.taxRecords.occurredAt, period.start),
          lte(this.taxRecords.occurredAt, period.end),
          period.jurisdiction === undefined
            ? undefined
            : sql`lower(${this.taxRecords.jurisdiction}) = lower(${period.jurisdiction})`,
        ),
      )
      .groupBy(this.taxRecords.paymentId, this.taxRecords.currency);
  }

  /**
   * Tax per jurisdiction and currency for the records that happened between `start` and `end`,
   * both inclusive, ordered by jurisdiction then currency. `customerId` limits it to one customer.
   */
  async totalsByJurisdiction(period: { start: Instant; end: Instant; customerId?: string; jurisdiction?: string }): Promise<TaxRecordTotal[]> {
    const { type, taxAmountMinor, reference } = this.taxRecords;

    return this.db
      .select({
        jurisdiction: this.taxRecords.jurisdiction,
        currency: this.taxRecords.currency,
        saleTaxMinor: sql<number>`coalesce(sum(${taxAmountMinor}) filter (where ${type} = 'sale'), 0)`.mapWith(Number),
        refundTaxMinor: sql<number>`coalesce(sum(${taxAmountMinor}) filter (where ${type} = 'refund'), 0)`.mapWith(Number),
        saleCount: sql<number>`count(distinct ${reference}) filter (where ${type} = 'sale')`.mapWith(Number),
        refundCount: sql<number>`count(distinct ${reference}) filter (where ${type} = 'refund')`.mapWith(Number),
      })
      .from(this.taxRecords)
      .where(
        and(
          gte(this.taxRecords.occurredAt, period.start),
          lte(this.taxRecords.occurredAt, period.end),
          period.customerId === undefined ? undefined : eq(this.taxRecords.customerId, period.customerId),
          period.jurisdiction === undefined
            ? undefined
            : sql`lower(${this.taxRecords.jurisdiction}) = lower(${period.jurisdiction})`,
        ),
      )
      .groupBy(this.taxRecords.jurisdiction, this.taxRecords.currency)
      .orderBy(this.taxRecords.jurisdiction, this.taxRecords.currency);
  }
}

/** The tax one payment carried, over the records that happened in a period. */
export type TaxRecordPaymentTotal = {
  paymentId: string;
  currency: string;
  saleTaxMinor: number;
  refundTaxMinor: number;
};

export type TaxRepositoryTables = Pick<
  TaxTables,
  'taxConfigurations' | 'taxJurisdictions' | 'taxExemptions' | 'taxRecords' | 'taxAuditEntries'
>;

/**
 * Aggregate Tax Repository Factory
 * Creates and manages all tax-related repositories
 */
export function createTaxRepositories(db: TaxDatabase, tables: TaxRepositoryTables) {
  return {
    configurations: new TaxConfigurationRepository(db, { taxConfigurations: tables.taxConfigurations }),
    jurisdictions: new TaxJurisdictionRepository(db, { taxJurisdictions: tables.taxJurisdictions }),
    exemptions: new TaxExemptionRepository(db, { taxExemptions: tables.taxExemptions }),
    records: new TaxRecordRepository(db, { taxRecords: tables.taxRecords }),
    audit: new TaxAuditRepository(db, { taxAuditEntries: tables.taxAuditEntries }),
  };
}

export type TaxRepositories = ReturnType<typeof createTaxRepositories>;
