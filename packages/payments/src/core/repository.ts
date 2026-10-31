import type { AnyRelations, SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, count, desc, eq, gte, lt, lte } from 'drizzle-orm';

import type { UserId } from './user-id.js';
import type { Instant } from '@arki/date';
import { now } from '@arki/date';
import type { FailureOf } from '@arki/failure';
import { invariant } from '@arki/failure';

import type { PaymentQuery, PlanQuery, SubscriptionQuery } from './contracts.js';
import type { CoreTables } from './tables.js';
import type {
  Customer,
  CustomerId,
  NewCustomer,
  NewPlan,
  NewWebhookEvent,
  Payment,
  PaymentId,
  PaymentProviderType,
  PaymentStatus,
  PaymentWithRelations,
  Plan,
  PlanId,
  PlanTier,
  Subscription,
  SubscriptionId,
  SubscriptionStatus,
  SubscriptionWithPlan,
  SubscriptionWithRelations,
  UpdateCustomer,
  UpdatePlan,
  UpdateWebhookEvent,
  WebhookEvent,
  WebhookEventType,
  WebhookId,
} from './types.js';
import { CustomerConflict, WebhookEventNotFound } from './failures.js';
import { ReferenceNotFound } from './providers/provider-error.js';
import { claimWebhookEvent, reclaimWebhookEvent } from './webhook-claims.js';

type NotFound = FailureOf<typeof ReferenceNotFound>;
type EventNotFound = FailureOf<typeof WebhookEventNotFound>;

/**
 * Structural database type accepted by the payments repositories.
 *
 * Mirrors drizzle's public surface: a `NodePgDatabase`, an in-flight `NodePgTransaction` or a
 * PGlite database. The repositories only use `select / insert / update / delete`, so no
 * relations graph is needed: a plain `drizzle({ client })` works.
 */
export type PaymentDatabase =
  | NodePgDatabase<AnyRelations>
  | NodePgTransaction<AnyRelations>
  | PgliteDatabase<AnyRelations>;

export class PaymentRepository {
  private readonly db: PaymentDatabase;
  private readonly plans: CoreTables['plans'];
  private readonly customers: CoreTables['customers'];
  private readonly subscriptions: CoreTables['subscriptions'];
  private readonly payments: CoreTables['payments'];
  private readonly webhookEvents: CoreTables['webhookEvents'];

  constructor(
    db: PaymentDatabase,
    tables: Pick<
      CoreTables,
      'plans' | 'customers' | 'subscriptions' | 'payments' | 'webhookEvents'
    >,
  ) {
    this.db = db;
    this.plans = tables.plans;
    this.customers = tables.customers;
    this.subscriptions = tables.subscriptions;
    this.payments = tables.payments;
    this.webhookEvents = tables.webhookEvents;
  }

  // Plan methods
  async createPlan(data: NewPlan): Promise<Plan> {
    const [row] = await this.db.insert(this.plans).values(data).returning();
    invariant(row, 'Failed to create plan');
    return row;
  }

  async findPlanById(id: PlanId): Promise<Plan | null> {
    const [plan] = await this.db.select().from(this.plans).where(eq(this.plans.id, id)).limit(1);
    return plan ?? null;
  }

  async findPlansByTier(tier: PlanTier): Promise<Plan[]> {
    return this.db
      .select()
      .from(this.plans)
      .where(and(eq(this.plans.tier, tier), eq(this.plans.isActive, true)))
      .orderBy(this.plans.priceMinor);
  }

  /** Plans matching the filters left in `query`, cheapest first within a tier, one page. */
  async findPlans(query: PlanQuery): Promise<Plan[]> {
    const { tier, interval, isActive, limit, offset } = query;

    return this.db
      .select()
      .from(this.plans)
      .where(
        and(
          tier ? eq(this.plans.tier, tier) : undefined,
          interval ? eq(this.plans.interval, interval) : undefined,
          isActive === undefined ? undefined : eq(this.plans.isActive, isActive),
        ),
      )
      .orderBy(this.plans.tier, this.plans.priceMinor, this.plans.id)
      .limit(limit)
      .offset(offset);
  }

  async findActivePlans(): Promise<Plan[]> {
    return this.db
      .select()
      .from(this.plans)
      .where(eq(this.plans.isActive, true))
      .orderBy(this.plans.tier, this.plans.priceMinor);
  }

  /** The updated plan, or `ReferenceNotFound` when no plan has this id. */
  async updatePlan(id: PlanId, data: UpdatePlan): Promise<Plan | NotFound> {
    const result = await this.db
      .update(this.plans)
      .set({ ...data, updatedAt: now() })
      .where(eq(this.plans.id, id))
      .returning();
    const row = result[0];
    if (!row) {
      return ReferenceNotFound({ kind: 'plan', id, missing: 'row' });
    }
    return row;
  }

  /** The deactivated plan, or `ReferenceNotFound` when no plan has this id. */
  async deactivatePlan(id: PlanId): Promise<Plan | NotFound> {
    const result = await this.db
      .update(this.plans)
      .set({ isActive: false, updatedAt: now() })
      .where(eq(this.plans.id, id))
      .returning();
    const row = result[0];
    if (!row) {
      return ReferenceNotFound({ kind: 'plan', id, missing: 'row' });
    }
    return row;
  }

  async getPlan(id: PlanId): Promise<Plan | null> {
    return this.findPlanById(id);
  }

  // Customer methods
  /**
   * A user has one customer, and a provider customer is one row. Two checkouts that race to
   * create the same customer both succeed: the second gets the row the first wrote. A customer
   * that clashes with a different one (another provider id for the user, or the provider id
   * of another user) is returned as `CustomerConflict`, never a silent pick of either row.
   */
  async createCustomer(data: NewCustomer): Promise<Customer | FailureOf<typeof CustomerConflict>> {
    const [created] = await this.db.insert(this.customers).values(data).onConflictDoNothing().returning();
    if (created) {
      return created;
    }

    const existing = await this.findCustomerByUserId(data.userId);
    if (existing && existing.providerCustomerId === data.providerCustomerId) {
      return existing;
    }

    return CustomerConflict({
      userId: data.userId,
      providerCustomerId: data.providerCustomerId,
      existingCustomerId: existing?.id ?? null,
    });
  }

  async findCustomerById(id: CustomerId): Promise<Customer | null> {
    const [customer] = await this.db.select().from(this.customers).where(eq(this.customers.id, id)).limit(1);
    return customer ?? null;
  }

  async findCustomerByUserId(userId: UserId): Promise<Customer | null> {
    const [customer] = await this.db
      .select()
      .from(this.customers)
      .where(eq(this.customers.userId, userId))
      .limit(1);
    return customer ?? null;
  }

  async findCustomerByProviderCustomerId(
    providerCustomerId: string,
    provider: PaymentProviderType,
  ): Promise<Customer | null> {
    const [customer] = await this.db
      .select()
      .from(this.customers)
      .where(and(eq(this.customers.providerCustomerId, providerCustomerId), eq(this.customers.provider, provider)))
      .limit(1);
    return customer ?? null;
  }

  /** The updated customer, or `ReferenceNotFound` when no customer has this id. */
  async updateCustomer(id: CustomerId, data: UpdateCustomer): Promise<Customer | NotFound> {
    const result = await this.db
      .update(this.customers)
      .set({ ...data, updatedAt: now() })
      .where(eq(this.customers.id, id))
      .returning();
    const row = result[0];
    if (!row) {
      return ReferenceNotFound({ kind: 'customer', id, missing: 'row' });
    }
    return row;
  }

  async deleteCustomer(id: CustomerId): Promise<void> {
    await this.db.delete(this.customers).where(eq(this.customers.id, id));
  }

  // Subscription methods
  async findSubscriptionById(id: SubscriptionId): Promise<SubscriptionWithPlan | null> {
    const [subscription] = await this.readSubscriptions({ where: eq(this.subscriptions.id, id), limit: 1 });
    return subscription ?? null;
  }

  async findSubscriptionsByUserId(userId: UserId): Promise<Subscription[]> {
    return this.readSubscriptions({
      where: eq(this.subscriptions.userId, userId),
      orderBy: [desc(this.subscriptions.createdAt)],
    });
  }

  /** Subscriptions matching the filters left in `query`, newest first, one page. */
  async findSubscriptions(query: SubscriptionQuery): Promise<Subscription[]> {
    const { status, planId, userId, limit, offset } = query;

    return this.readSubscriptions({
      where: and(
        status ? eq(this.subscriptions.status, status) : undefined,
        planId ? eq(this.subscriptions.planId, planId) : undefined,
        userId ? eq(this.subscriptions.userId, userId) : undefined,
      ),
      orderBy: [desc(this.subscriptions.createdAt), this.subscriptions.id],
      limit,
      offset,
    });
  }

  async findActiveSubscriptionByUserId(userId: UserId): Promise<SubscriptionWithPlan | null> {
    const [subscription] = await this.readSubscriptions({
      where: and(eq(this.subscriptions.userId, userId), eq(this.subscriptions.status, 'active')),
      limit: 1,
    });
    return subscription ?? null;
  }

  async findSubscriptionByProviderSubscriptionId(
    providerSubscriptionId: string,
  ): Promise<Subscription | null> {
    const [subscription] = await this.readSubscriptions({
      where: eq(this.subscriptions.providerSubscriptionId, providerSubscriptionId),
      limit: 1,
    });
    return subscription ?? null;
  }

  async findSubscriptionsByStatus(status: SubscriptionStatus): Promise<Subscription[]> {
    return this.readSubscriptions({
      where: eq(this.subscriptions.status, status),
      orderBy: [desc(this.subscriptions.createdAt)],
    });
  }

  async findSubscriptionsEndingInRange(startDate: Instant, endDate: Instant): Promise<Subscription[]> {
    return this.readSubscriptions({
      where: and(
        gte(this.subscriptions.currentPeriodEnd, startDate),
        lte(this.subscriptions.currentPeriodEnd, endDate),
        eq(this.subscriptions.status, 'active'),
      ),
      orderBy: [this.subscriptions.currentPeriodEnd],
    });
  }

  async getSubscription(id: SubscriptionId): Promise<Subscription | null> {
    return this.findSubscriptionById(id);
  }

  // Payment methods
  async findPaymentById(id: PaymentId): Promise<Payment | null> {
    const [payment] = await this.readPayments({ where: eq(this.payments.id, id), limit: 1 });
    return payment ?? null;
  }

  async findPaymentsByUserId(userId: UserId, limit = 50): Promise<Payment[]> {
    return this.readPayments({
      where: eq(this.payments.userId, userId),
      orderBy: [desc(this.payments.createdAt)],
      limit,
    });
  }

  /** Payments matching the filters left in `query`, newest first, one page. `startDate` and `endDate` bound `createdAt`, both inclusive. */
  async findPayments(query: PaymentQuery): Promise<Payment[]> {
    const { status, subscriptionId, customerId, userId, startDate, endDate, limit, offset } = query;

    return this.readPayments({
      where: and(
        status ? eq(this.payments.status, status) : undefined,
        subscriptionId ? eq(this.payments.subscriptionId, subscriptionId) : undefined,
        customerId ? eq(this.payments.customerId, customerId) : undefined,
        userId ? eq(this.payments.userId, userId) : undefined,
        startDate ? gte(this.payments.createdAt, startDate) : undefined,
        endDate ? lte(this.payments.createdAt, endDate) : undefined,
      ),
      orderBy: [desc(this.payments.createdAt), this.payments.id],
      limit,
      offset,
    });
  }

  async findPaymentsBySubscriptionId(subscriptionId: SubscriptionId): Promise<Payment[]> {
    return this.readPayments({
      where: eq(this.payments.subscriptionId, subscriptionId),
      orderBy: [desc(this.payments.createdAt)],
    });
  }

  async findPaymentByProviderPaymentId(providerPaymentId: string): Promise<Payment | null> {
    const [payment] = await this.readPayments({
      where: eq(this.payments.providerPaymentId, providerPaymentId),
      limit: 1,
    });
    return payment ?? null;
  }

  async findPaymentsByStatus(status: PaymentStatus): Promise<Payment[]> {
    return this.readPayments({
      where: eq(this.payments.status, status),
      orderBy: [desc(this.payments.createdAt)],
    });
  }

  /**
   * Subscriptions with their plan and customer. Both foreign keys are required, so both joins
   * are inner joins. `limit`, `offset` and `orderBy` are optional parts of one query.
   */
  private async readSubscriptions(options: {
    where?: SQL;
    orderBy?: (SQL | AnyPgColumn)[];
    limit?: number;
    offset?: number;
  }) {
    const { where, orderBy = [], limit, offset } = options;
    const query = this.db
      .select({ subscription: this.subscriptions, plan: this.plans, customer: this.customers })
      .from(this.subscriptions)
      .innerJoin(this.plans, eq(this.subscriptions.planId, this.plans.id))
      .innerJoin(this.customers, eq(this.subscriptions.customerId, this.customers.id))
      .where(where)
      .orderBy(...orderBy)
      .$dynamic();
    const rows = await (limit === undefined ? query : query.limit(limit).offset(offset ?? 0));

    return rows.map(({ subscription, plan, customer }) => ({ ...subscription, plan, customer }));
  }

  /**
   * Payments with their customer and, when the payment has a subscription, that subscription
   * with its plan. A payment without a subscription has no `subscription` field.
   */
  private async readPayments(options: {
    where?: SQL;
    orderBy?: (SQL | AnyPgColumn)[];
    limit?: number;
    offset?: number;
  }) {
    const { where, orderBy = [], limit, offset } = options;
    const query = this.db
      .select({
        payment: this.payments,
        subscription: this.subscriptions,
        plan: this.plans,
        customer: this.customers,
      })
      .from(this.payments)
      .leftJoin(this.subscriptions, eq(this.payments.subscriptionId, this.subscriptions.id))
      .leftJoin(this.plans, eq(this.subscriptions.planId, this.plans.id))
      .innerJoin(this.customers, eq(this.payments.customerId, this.customers.id))
      .where(where)
      .orderBy(...orderBy)
      .$dynamic();
    const rows = await (limit === undefined ? query : query.limit(limit).offset(offset ?? 0));

    return rows.map(({ payment, subscription, plan, customer }) => ({
      ...payment,
      subscription: subscription ? { ...subscription, plan: plan ?? undefined } : undefined,
      customer,
    }));
  }


  // Webhook event methods
  async createWebhookEvent(data: NewWebhookEvent): Promise<WebhookEvent> {
    const [row] = await this.db.insert(this.webhookEvents).values(data).returning();
    invariant(row, 'Failed to create webhook event');
    return row;
  }

  /** Insert the event, or return the row that holds its id. See `claimWebhookEvent` in `webhook-claims.ts`. */
  async claimWebhookEvent(data: NewWebhookEvent): ReturnType<typeof claimWebhookEvent> {
    return claimWebhookEvent(this.db, this.webhookEvents, data);
  }

  /** Take over a failed or stale unprocessed event. See `reclaimWebhookEvent` in `webhook-claims.ts`. */
  async reclaimWebhookEvent(id: WebhookId, seenAttempts: number, leaseCutoff: Instant): Promise<boolean> {
    return reclaimWebhookEvent(this.db, this.webhookEvents, id, seenAttempts, leaseCutoff);
  }

  async findWebhookEventById(id: WebhookId): Promise<WebhookEvent | null> {
    const [webhookEvent] = await this.db
      .select()
      .from(this.webhookEvents)
      .where(eq(this.webhookEvents.id, id))
      .limit(1);
    return webhookEvent ?? null;
  }

  async findWebhookEventByProviderEventId(
    providerEventId: string,
    provider: PaymentProviderType,
  ): Promise<WebhookEvent | null> {
    const [webhookEvent] = await this.db
      .select()
      .from(this.webhookEvents)
      .where(and(eq(this.webhookEvents.providerEventId, providerEventId), eq(this.webhookEvents.provider, provider)))
      .limit(1);
    return webhookEvent ?? null;
  }

  async findUnprocessedWebhookEvents(limit = 100): Promise<WebhookEvent[]> {
    return this.db
      .select()
      .from(this.webhookEvents)
      .where(eq(this.webhookEvents.processed, false))
      .orderBy(this.webhookEvents.createdAt)
      .limit(limit);
  }

  async findWebhookEventsByType(eventType: WebhookEventType): Promise<WebhookEvent[]> {
    return this.db
      .select()
      .from(this.webhookEvents)
      .where(eq(this.webhookEvents.eventType, eventType))
      .orderBy(desc(this.webhookEvents.createdAt));
  }

  /** The updated event, or `WebhookEventNotFound` when no event has this id. */
  async updateWebhookEvent(id: WebhookId, data: UpdateWebhookEvent): Promise<WebhookEvent | EventNotFound> {
    const result = await this.db
      .update(this.webhookEvents)
      .set({ ...data, updatedAt: now() })
      .where(eq(this.webhookEvents.id, id))
      .returning();
    const row = result[0];
    if (!row) {
      return WebhookEventNotFound({ webhookId: id });
    }
    return row;
  }

  /** The processed event, or `WebhookEventNotFound` when no event has this id. */
  async markWebhookEventAsProcessed(id: WebhookId): Promise<WebhookEvent | EventNotFound> {
    const result = await this.db
      .update(this.webhookEvents)
      .set({
        processed: true,
        processedAt: now(),
        updatedAt: now(),
      })
      .where(eq(this.webhookEvents.id, id))
      .returning();
    const row = result[0];
    if (!row) {
      return WebhookEventNotFound({ webhookId: id });
    }
    return row;
  }

  /** The event with one more attempt, or `WebhookEventNotFound` when no event has this id. */
  async incrementWebhookEventAttempts(id: WebhookId, errorMessage?: string): Promise<WebhookEvent | EventNotFound> {
    const currentEvent = await this.findWebhookEventById(id);
    if (!currentEvent) {
      return WebhookEventNotFound({ webhookId: id });
    }

    const result = await this.db
      .update(this.webhookEvents)
      .set({
        attempts: currentEvent.attempts + 1,
        lastAttemptAt: now(),
        errorMessage,
        updatedAt: now(),
      })
      .where(eq(this.webhookEvents.id, id))
      .returning();
    const row = result[0];
    // The row was read above: an update that matches nothing means it was deleted in between
    if (!row) {
      return WebhookEventNotFound({ webhookId: id });
    }
    return row;
  }

  // Analytics and reporting methods
  async getSubscriptionStats(
    startDate?: Instant,
    endDate?: Instant,
  ): Promise<SubscriptionWithRelations[]> {
    const rows = await this.db
      .select({ subscription: this.subscriptions, plan: this.plans })
      .from(this.subscriptions)
      .innerJoin(this.plans, eq(this.subscriptions.planId, this.plans.id))
      .where(
        and(
          startDate ? gte(this.subscriptions.createdAt, startDate) : undefined,
          endDate ? lte(this.subscriptions.createdAt, endDate) : undefined,
        ),
      );

    return rows.map(({ subscription, plan }) => ({ ...subscription, plan }));
  }

  async getPaymentStats(startDate?: Instant, endDate?: Instant): Promise<PaymentWithRelations[]> {
    // The plan is loaded too: `getSubscriptionAnalytics` splits revenue by its interval.
    const rows = await this.db
      .select({ payment: this.payments, subscription: this.subscriptions, plan: this.plans })
      .from(this.payments)
      .leftJoin(this.subscriptions, eq(this.payments.subscriptionId, this.subscriptions.id))
      .leftJoin(this.plans, eq(this.subscriptions.planId, this.plans.id))
      .where(
        and(
          startDate ? gte(this.payments.createdAt, startDate) : undefined,
          endDate ? lte(this.payments.createdAt, endDate) : undefined,
        ),
      );

    return rows.map(({ payment, subscription, plan }) => ({
      ...payment,
      subscription: subscription ? { ...subscription, plan: plan ?? undefined } : undefined,
    }));
  }

  async getCustomerCount(): Promise<number> {
    const [row] = await this.db.select({ total: count() }).from(this.customers);
    return row?.total ?? 0;
  }

  async getActiveSubscriptionCount(): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(this.subscriptions)
      .where(eq(this.subscriptions.status, 'active'));
    return row?.total ?? 0;
  }

  /** How many payments were created from `start` (included) to `end` (excluded). */
  async countPaymentsCreatedBetween(start: Instant, end: Instant): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(this.payments)
      .where(and(gte(this.payments.createdAt, start), lt(this.payments.createdAt, end)));
    return row?.total ?? 0;
  }
}

export type CreatePaymentRepositoryDeps = {
  tables: Pick<CoreTables, 'plans' | 'customers' | 'subscriptions' | 'payments' | 'webhookEvents'>;
};

export function createPaymentRepository(
  db: PaymentDatabase,
  { tables }: CreatePaymentRepositoryDeps,
): PaymentRepository {
  return new PaymentRepository(db, tables);
}
