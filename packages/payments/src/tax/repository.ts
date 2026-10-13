import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import { and, desc, eq, sql } from 'drizzle-orm';

import { now } from '@arki/date';

import type { TaxConfigId, TaxExemptionId, TaxJurisdictionId } from './primitives.js';
import type { TaxTables } from './tables.js';
import type {
  NewTaxConfig,
  NewTaxExemption,
  NewTaxJurisdiction,
  TaxConfig,
  TaxExemption,
  TaxJurisdiction,
} from './types.js';

/**
 * Structural database type for the tax repositories. The tax repositories
 * only use `db.select / insert / update / delete` (no relational query
 * builder), so `AnyRelations` is sufficient — no host-side relations
 * contract is required beyond having the tax tables in the schema.
 */
export type TaxDatabase =
  | NodePgDatabase<AnyRelations>
  | NodePgTransaction<AnyRelations>;

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
    totalExpired: number;
    totalRevoked: number;
    expiringNext30Days: number;
  }> {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);

    const [activeCount] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(this.taxExemptions)
      .where(eq(this.taxExemptions.status, 'active'));

    const [expiredCount] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(this.taxExemptions)
      .where(eq(this.taxExemptions.status, 'expired'));

    const [revokedCount] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(this.taxExemptions)
      .where(eq(this.taxExemptions.status, 'revoked'));

    const [expiringCount] = await this.db
      .select({ count: sql<number>`count(*)` })
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
      totalExpired: expiredCount?.count || 0,
      totalRevoked: revokedCount?.count || 0,
      expiringNext30Days: expiringCount?.count || 0,
    };
  }
}

export type TaxRepositoryTables = Pick<
  TaxTables,
  'taxConfigurations' | 'taxJurisdictions' | 'taxExemptions'
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
  };
}

export type TaxRepositories = ReturnType<typeof createTaxRepositories>;
