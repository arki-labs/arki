import type { AnyRelations } from 'drizzle-orm';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';

import type { UserId } from '@arki/auth/ids';

import type { PaymentId } from '../core/primitives';
import type { RefundId, RefundReason, RefundStatus } from './primitives';
import type { RefundsTables } from './tables';
import type { NewRefund, Refund, UpdateRefund } from './types';

/**
 * Structural database type for the refunds repository. Only uses
 * `db.select / insert / update / delete`, so `AnyRelations` suffices —
 * the host needs to register the `refunds` table in its schema but no
 * specific relations graph is required.
 */
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

  async create(data: NewRefund): Promise<Refund> {
    const [refund] = await this.db.insert(this.refunds).values(data).returning();
    if (!refund) {
      throw new Error('Failed to create refund');
    }
    return refund as Refund;
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

  async update(refundId: RefundId, data: UpdateRefund): Promise<Refund> {
    const [updated] = await this.db
      .update(this.refunds)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(this.refunds.id, refundId))
      .returning();

    if (!updated) {
      throw new Error(`Refund ${refundId} not found`);
    }

    return updated as Refund;
  }

  async approve(refundId: RefundId, approvedBy: UserId): Promise<Refund> {
    return this.update(refundId, {
      status: 'approved',
      approvedBy,
      approvedAt: new Date(),
    });
  }

  async reject(refundId: RefundId, rejectedBy: UserId, reason: string): Promise<Refund> {
    return this.update(refundId, {
      status: 'rejected',
      rejectedBy,
      rejectionReason: reason,
    });
  }

  async markAsProcessing(refundId: RefundId): Promise<Refund> {
    return this.update(refundId, {
      status: 'processing',
      processedAt: new Date(),
    });
  }

  async markAsCompleted(
    refundId: RefundId,
    providerRefundId: string,
    providerResponse?: string,
  ): Promise<Refund> {
    return this.update(refundId, {
      status: 'completed',
      providerRefundId,
      providerResponse,
      completedAt: new Date(),
    });
  }

  async markAsFailed(refundId: RefundId, error: string): Promise<Refund> {
    return this.update(refundId, {
      status: 'failed',
      providerResponse: JSON.stringify({ error }),
    });
  }

  async getTotalRefundedAmount(paymentId: PaymentId): Promise<number> {
    const result = await this.db
      .select({
        total: sql<number>`SUM(CAST(${this.refunds.refundAmount} AS DECIMAL))`,
      })
      .from(this.refunds)
      .where(and(eq(this.refunds.paymentId, paymentId), eq(this.refunds.status, 'completed')));

    return result[0]?.total ?? 0;
  }

  async getRefundMetrics(
    startDate?: Date,
    endDate?: Date,
  ): Promise<{
    totalCount: number;
    totalAmount: number;
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
      totalAmount: allRefunds.reduce((sum, r) => sum + Number.parseFloat(r.refundAmount || '0'), 0),
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
        return sum + (refund.completedAt.getTime() - refund.requestedAt.getTime());
      }
      return sum;
    }, 0);

    return totalTime / completedRefunds.length;
  }

  async searchRefunds(filters: {
    status?: RefundStatus;
    reason?: RefundReason;
    userId?: UserId;
    startDate?: Date;
    endDate?: Date;
    minAmount?: number;
    maxAmount?: number;
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
      conditions.push(sql`CAST(${this.refunds.refundAmount} AS DECIMAL) >= ${filters.minAmount}`);
    }
    if (filters.maxAmount !== undefined) {
      conditions.push(sql`CAST(${this.refunds.refundAmount} AS DECIMAL) <= ${filters.maxAmount}`);
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
