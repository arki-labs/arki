import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';

import type { UserId } from '../core/user-id.js';
import type { Instant } from '@arki/date';
import type { Money } from '@arki/money';
import { toMillis } from '@arki/date';
import { MoneyBag } from '@arki/money/bag';

import type { PaymentId } from '../core/primitives.js';
import type { RefundId, RefundReason, RefundStatus } from './primitives.js';
import type { RefundsTables } from './tables.js';
import type { Refund } from './types.js';
import { fromMinorColumn, toMinorColumn } from '../core/money.js';

/**
 * Structural database type for the refunds repository. Only uses
 * `db.select / insert / update / delete`, so `AnyRelations` suffices —
 * the host needs to register the `refunds` table in its schema but no
 * specific relations graph is required.
 */
/** A refund row's amount: whole minor units and a currency that defaults to USD, as the column does. */
export function refundAmountOf(refund: Pick<Refund, 'refundAmountMinor' | 'currency'>): Money {
  return fromMinorColumn(refund.refundAmountMinor, refund.currency ?? 'USD');
}

export type RefundsDatabase =
  | NodePgDatabase<AnyRelations>
  | NodePgTransaction<AnyRelations>;

export class RefundRepository {
  private readonly db: RefundsDatabase;
  private readonly refunds: RefundsTables['refunds'];

  constructor(db: RefundsDatabase, tables: Pick<RefundsTables, 'refunds'>) {
    this.db = db;
    this.refunds = tables.refunds;
  }

  async findById(refundId: RefundId): Promise<Refund | null> {
    const [refund] = await this.db
      .select()
      .from(this.refunds)
      .where(eq(this.refunds.id, refundId))
      .limit(1);
    return (refund as Refund | undefined) ?? null;
  }

  async findByPaymentId(paymentId: PaymentId): Promise<Refund[]> {
    return this.db
      .select()
      .from(this.refunds)
      .where(eq(this.refunds.paymentId, paymentId))
      .orderBy(desc(this.refunds.createdAt)) as Promise<Refund[]>;
  }

  async findByStatus(status: RefundStatus): Promise<Refund[]> {
    return this.db
      .select()
      .from(this.refunds)
      .where(eq(this.refunds.status, status))
      .orderBy(desc(this.refunds.createdAt)) as Promise<Refund[]>;
  }

  async findPending(): Promise<Refund[]> {
    return this.findByStatus('pending');
  }

  async findByUser(userId: UserId): Promise<Refund[]> {
    return this.db
      .select()
      .from(this.refunds)
      .where(eq(this.refunds.requestedBy, userId))
      .orderBy(desc(this.refunds.createdAt)) as Promise<Refund[]>;
  }

  /** Completed refunds of a payment, in the payment's currency. */
  async getTotalRefundedAmount(paymentId: PaymentId, currency: string): Promise<Money> {
    const result = await this.db
      .select({
        // A `bigint` sum is `numeric`: Postgres sends it as text, exact
        total: sql<string | null>`SUM(${this.refunds.refundAmountMinor})`,
      })
      .from(this.refunds)
      .where(
        and(
          eq(this.refunds.paymentId, paymentId),
          eq(this.refunds.status, 'completed'),
          eq(this.refunds.currency, currency.toUpperCase()),
        ),
      );

    return fromMinorColumn(result[0]?.total ?? '0', currency);
  }

  async getRefundMetrics(
    startDate?: Instant,
    endDate?: Instant,
  ): Promise<{
    totalCount: number;
    /** One exact total per currency: refunds in USD and EUR do not add up to one number */
    totalAmount: MoneyBag;
    byStatus: Record<string, number>;
    byReason: Record<string, number>;
  }> {
    const conditions = [];
    if (startDate) {
      conditions.push(gte(this.refunds.createdAt, startDate));
    }
    if (endDate) {
      conditions.push(lte(this.refunds.createdAt, endDate));
    }

    const baseQuery =
      conditions.length > 0
        ? this.db.select().from(this.refunds).where(and(...conditions))
        : this.db.select().from(this.refunds);

    const allRefunds = (await baseQuery) as Refund[];

    const metrics = {
      totalCount: allRefunds.length,
      totalAmount: MoneyBag.empty().plus(...allRefunds.map(refund => refundAmountOf(refund))),
      byStatus: {} as Record<string, number>,
      byReason: {} as Record<string, number>,
    };

    for (const refund of allRefunds) {
      const status = refund.status as string;
      metrics.byStatus[status] = (metrics.byStatus[status] || 0) + 1;
      metrics.byReason[refund.reason] = (metrics.byReason[refund.reason] || 0) + 1;
    }

    return metrics;
  }

  async getAverageProcessingTime(): Promise<number> {
    const completedRefunds = await this.db
      .select({
        requestedAt: this.refunds.requestedAt,
        completedAt: this.refunds.completedAt,
      })
      .from(this.refunds)
      .where(eq(this.refunds.status, 'completed'));

    if (completedRefunds.length === 0) return 0;

    const totalTime = completedRefunds.reduce((sum, refund) => {
      if (refund.completedAt && refund.requestedAt) {
        return sum + (toMillis(refund.completedAt) - toMillis(refund.requestedAt));
      }
      return sum;
    }, 0);

    return totalTime / completedRefunds.length;
  }

  async searchRefunds(filters: {
    status?: RefundStatus;
    reason?: RefundReason;
    userId?: UserId;
    startDate?: Instant;
    endDate?: Instant;
    /** Bounds also select their currency: refunds in another currency are left out */
    minAmount?: Money;
    maxAmount?: Money;
  }): Promise<Refund[]> {
    const conditions = [];

    if (filters.status) {
      conditions.push(eq(this.refunds.status, filters.status));
    }
    if (filters.reason) {
      conditions.push(eq(this.refunds.reason, filters.reason));
    }
    if (filters.userId) {
      conditions.push(eq(this.refunds.requestedBy, filters.userId));
    }
    if (filters.startDate) {
      conditions.push(gte(this.refunds.createdAt, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(this.refunds.createdAt, filters.endDate));
    }
    if (filters.minAmount !== undefined) {
      conditions.push(
        eq(this.refunds.currency, filters.minAmount.currency.code),
        gte(this.refunds.refundAmountMinor, toMinorColumn(filters.minAmount)),
      );
    }
    if (filters.maxAmount !== undefined) {
      conditions.push(
        eq(this.refunds.currency, filters.maxAmount.currency.code),
        lte(this.refunds.refundAmountMinor, toMinorColumn(filters.maxAmount)),
      );
    }

    return this.db
      .select()
      .from(this.refunds)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(this.refunds.createdAt)) as Promise<Refund[]>;
  }
}

export function createRefundRepository(
  db: RefundsDatabase,
  tables: Pick<RefundsTables, 'refunds'>,
): RefundRepository {
  return new RefundRepository(db, tables);
}
