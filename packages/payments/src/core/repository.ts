import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';

import type { UserId } from './user-id.js';
import type { Instant } from '@arki/date';
import { now } from '@arki/date';

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

/**
 * Structural database type accepted by the payments repositories.
 *
 * Mirrors drizzle's public surface: a `NodePgDatabase<TRelations>` or an
 * in-flight `NodePgTransaction<TRelations>`. Apps supply their own concrete
 * relations type (parameterised over their full relations graph). The
 * contract: the relations graph MUST register the payment tables (`plans`,
 * `customers`, `subscriptions`, `payments`, `webhookEvents`) with the
 * relations required below — without those, `db.query.<table>.findFirst({
 * with: { ... } })` calls fail at runtime.
 *
 * `AnyRelations` is used as the upper bound because the precise relations
 * graph is unknown to the package — type fidelity is recovered inside the
 * repository via an internal precise view (see `PaymentDbInternal`).
 */
export type PaymentDatabase =
  | NodePgDatabase<AnyRelations>
  | NodePgTransaction<AnyRelations>;

type FieldFilter<T> =
  | T
  | {
      eq?: T;
      ne?: T;
      gt?: T;
      gte?: T;
      lt?: T;
      lte?: T;
      in?: T[];
      notIn?: T[];
      like?: string;
      notLike?: string;
      ilike?: string;
      notIlike?: string;
      isNull?: boolean;
      isNotNull?: boolean;
    };

type WhereClause<T> = { [K in keyof T]?: FieldFilter<T[K]> };

type FindFirst<TResult, TWith = void> = (config: {
  where?: WhereClause<TResult>;
  with?: TWith;
  columns?: Record<string, boolean>;
}) => Promise<TResult | undefined>;

type FindMany<TResult, TWith = void> = (config: {
  where?: WhereClause<TResult>;
  with?: TWith;
  columns?: Record<string, boolean>;
  orderBy?: (
    table: TResult,
    helpers: { desc: (col: unknown) => unknown; asc: (col: unknown) => unknown },
  ) => unknown[];
  limit?: number;
  offset?: number;
}) => Promise<TResult[]>;

type SubscriptionJoinSpec = {
  plan?: true;
  customer?: true;
};

type PaymentJoinSpec = {
  subscription?: true | { with?: { plan?: true } };
  customer?: true;
};

/**
 * Precise internal view of the relational query builder for tables this
 * repository owns. The constructor obtains this view via a single,
 * documented cast — see comment in {@link PaymentRepository.constructor}.
 */
type PaymentDbInternal = {
  query: {
    plans: {
      findFirst: FindFirst<Plan>;
      findMany: FindMany<Plan>;
    };
    customers: {
      findFirst: FindFirst<Customer>;
      findMany: FindMany<Customer>;
    };
    subscriptions: {
      findFirst: FindFirst<SubscriptionWithRelations, SubscriptionJoinSpec>;
      findMany: FindMany<SubscriptionWithRelations, SubscriptionJoinSpec>;
    };
    payments: {
      findFirst: FindFirst<PaymentWithRelations, PaymentJoinSpec>;
      findMany: FindMany<PaymentWithRelations, PaymentJoinSpec>;
    };
    webhookEvents: {
      findFirst: FindFirst<WebhookEvent>;
      findMany: FindMany<WebhookEvent>;
    };
  };
};

export class PaymentRepository {
  private readonly db: PaymentDatabase;
  private readonly q: PaymentDbInternal['query'];
  private readonly plans: CoreTables['plans'];
  private readonly customers: CoreTables['customers'];
  private readonly subscriptions: CoreTables['subscriptions'];
  private readonly webhookEvents: CoreTables['webhookEvents'];

  constructor(
    db: PaymentDatabase,
    tables: Pick<
      CoreTables,
      'plans' | 'customers' | 'subscriptions' | 'payments' | 'webhookEvents'
    >,
  ) {
    this.db = db;
    // Single boundary cast: drizzle's RQB types are parameterised by the
    // host's full relations graph (unknown at package level). The host
    // contract guarantees the listed tables are registered with their
    // relations — see `PaymentDatabase` doc.
    this.q = db.query as unknown as PaymentDbInternal['query'];
    this.plans = tables.plans;
    this.customers = tables.customers;
    this.subscriptions = tables.subscriptions;
    this.webhookEvents = tables.webhookEvents;
  }

  // Plan methods
  async createPlan(data: NewPlan): Promise<Plan> {
    const result = await this.db.insert(this.plans).values(data).returning();
    const row = result[0];
    if (!row) {
      throw new Error('Failed to create plan');
    }
    return row as Plan;
  }

  async findPlanById(id: PlanId): Promise<Plan | null> {
    const plan = await this.q.plans.findFirst({ where: { id } });
    return plan ?? null;
  }

  async findPlansByTier(tier: PlanTier): Promise<Plan[]> {
    return this.q.plans.findMany({
      where: { tier, isActive: true },
      orderBy: (t) => [t.priceMinor],
    });
  }

  async findActivePlans(): Promise<Plan[]> {
    return this.q.plans.findMany({
      where: { isActive: true },
      orderBy: (t) => [t.tier, t.priceMinor],
    });
  }

  async updatePlan(id: PlanId, data: UpdatePlan): Promise<Plan> {
    const result = await this.db
      .update(this.plans)
      .set({ ...data, updatedAt: now() })
      .where(eq(this.plans.id, id))
      .returning();
    const row = result[0];
    if (!row) {
      throw new Error('Failed to update plan or plan not found');
    }
    return row as Plan;
  }

  async deactivatePlan(id: PlanId): Promise<Plan> {
    const result = await this.db
      .update(this.plans)
      .set({ isActive: false, updatedAt: now() })
      .where(eq(this.plans.id, id))
      .returning();
    const row = result[0];
    if (!row) {
      throw new Error('Failed to deactivate plan or plan not found');
    }
    return row as Plan;
  }

  async getPlan(id: PlanId): Promise<Plan | null> {
    return this.findPlanById(id);
  }

  // Customer methods
  async createCustomer(data: NewCustomer): Promise<Customer> {
    const result = await this.db.insert(this.customers).values(data).returning();
    const row = result[0];
    if (!row) {
      throw new Error('Failed to create customer');
    }
    return row as Customer;
  }

  async findCustomerById(id: CustomerId): Promise<Customer | null> {
    const customer = await this.q.customers.findFirst({ where: { id } });
    return customer ?? null;
  }

  async findCustomerByUserId(userId: UserId): Promise<Customer | null> {
    const customer = await this.q.customers.findFirst({ where: { userId } });
    return customer ?? null;
  }

  async findCustomerByProviderCustomerId(
    providerCustomerId: string,
    provider: PaymentProviderType,
  ): Promise<Customer | null> {
    const customer = await this.q.customers.findFirst({
      where: { providerCustomerId, provider },
    });
    return customer ?? null;
  }

  async updateCustomer(id: CustomerId, data: UpdateCustomer): Promise<Customer> {
    const result = await this.db
      .update(this.customers)
      .set({ ...data, updatedAt: now() })
      .where(eq(this.customers.id, id))
      .returning();
    const row = result[0];
    if (!row) {
      throw new Error('Failed to update customer or customer not found');
    }
    return row as Customer;
  }

  async deleteCustomer(id: CustomerId): Promise<void> {
    await this.db.delete(this.customers).where(eq(this.customers.id, id));
  }

  // Subscription methods
  async findSubscriptionById(id: SubscriptionId): Promise<SubscriptionWithPlan | null> {
    const subscription = await this.q.subscriptions.findFirst({
      where: { id },
      with: { plan: true, customer: true },
    });
    if (!subscription) return null;
    const row = subscription as Subscription & { plan?: Plan; customer?: Customer };
    return { ...row, plan: row.plan as Plan, customer: row.customer };
  }

  async findSubscriptionsByUserId(userId: UserId): Promise<Subscription[]> {
    return this.q.subscriptions.findMany({
      where: { userId },
      with: { plan: true, customer: true },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  async findActiveSubscriptionByUserId(userId: UserId): Promise<SubscriptionWithPlan | null> {
    const subscription = await this.q.subscriptions.findFirst({
      where: { userId, status: 'active' },
      with: { plan: true, customer: true },
    });
    if (!subscription) return null;
    const row = subscription as Subscription & { plan?: Plan; customer?: Customer };
    return { ...row, plan: row.plan as Plan, customer: row.customer };
  }

  async findSubscriptionByProviderSubscriptionId(
    providerSubscriptionId: string,
  ): Promise<Subscription | null> {
    const subscription = await this.q.subscriptions.findFirst({
      where: { providerSubscriptionId },
      with: { plan: true, customer: true },
    });
    return subscription ?? null;
  }

  async findSubscriptionsByStatus(status: SubscriptionStatus): Promise<Subscription[]> {
    return this.q.subscriptions.findMany({
      where: { status },
      with: { plan: true, customer: true },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  async findSubscriptionsEndingInRange(startDate: Instant, endDate: Instant): Promise<Subscription[]> {
    return this.q.subscriptions.findMany({
      where: {
        currentPeriodEnd: { gte: startDate, lte: endDate },
        status: 'active',
      },
      with: { plan: true, customer: true },
      orderBy: (t) => [t.currentPeriodEnd],
    });
  }

  async getSubscription(id: SubscriptionId): Promise<Subscription | null> {
    return this.findSubscriptionById(id);
  }

  // Payment methods
  async findPaymentById(id: PaymentId): Promise<Payment | null> {
    const payment = await this.q.payments.findFirst({
      where: { id },
      with: {
        subscription: { with: { plan: true } },
        customer: true,
      },
    });
    return payment ?? null;
  }

  async findPaymentsByUserId(userId: UserId, limit = 50): Promise<Payment[]> {
    return this.q.payments.findMany({
      where: { userId },
      with: {
        subscription: { with: { plan: true } },
        customer: true,
      },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit,
    });
  }

  async findPaymentsBySubscriptionId(subscriptionId: SubscriptionId): Promise<Payment[]> {
    return this.q.payments.findMany({
      where: { subscriptionId },
      with: {
        subscription: { with: { plan: true } },
        customer: true,
      },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  async findPaymentByProviderPaymentId(providerPaymentId: string): Promise<Payment | null> {
    const payment = await this.q.payments.findFirst({
      where: { providerPaymentId },
      with: {
        subscription: { with: { plan: true } },
        customer: true,
      },
    });
    return payment ?? null;
  }

  async findPaymentsByStatus(status: PaymentStatus): Promise<Payment[]> {
    return this.q.payments.findMany({
      where: { status },
      with: {
        subscription: { with: { plan: true } },
        customer: true,
      },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  // Webhook event methods
  async createWebhookEvent(data: NewWebhookEvent): Promise<WebhookEvent> {
    const result = await this.db.insert(this.webhookEvents).values(data).returning();
    const row = result[0];
    if (!row) {
      throw new Error('Failed to create webhook event');
    }
    return row as WebhookEvent;
  }

  async findWebhookEventById(id: WebhookId): Promise<WebhookEvent | null> {
    const webhookEvent = await this.q.webhookEvents.findFirst({ where: { id } });
    return webhookEvent ?? null;
  }

  async findWebhookEventByProviderEventId(
    providerEventId: string,
    provider: PaymentProviderType,
  ): Promise<WebhookEvent | null> {
    const webhookEvent = await this.q.webhookEvents.findFirst({
      where: { providerEventId, provider },
    });
    return webhookEvent ?? null;
  }

  async findUnprocessedWebhookEvents(limit = 100): Promise<WebhookEvent[]> {
    return this.q.webhookEvents.findMany({
      where: { processed: false },
      orderBy: (t) => [t.createdAt],
      limit,
    });
  }

  async findWebhookEventsByType(eventType: WebhookEventType): Promise<WebhookEvent[]> {
    return this.q.webhookEvents.findMany({
      where: { eventType },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  async updateWebhookEvent(id: WebhookId, data: UpdateWebhookEvent): Promise<WebhookEvent> {
    const result = await this.db
      .update(this.webhookEvents)
      .set({ ...data, updatedAt: now() })
      .where(eq(this.webhookEvents.id, id))
      .returning();
    const row = result[0];
    if (!row) {
      throw new Error('Failed to update webhook event or webhook event not found');
    }
    return row as WebhookEvent;
  }

  async markWebhookEventAsProcessed(id: WebhookId): Promise<WebhookEvent> {
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
      throw new Error('Failed to mark webhook event as processed or webhook event not found');
    }
    return row as WebhookEvent;
  }

  async incrementWebhookEventAttempts(id: WebhookId, errorMessage?: string): Promise<WebhookEvent> {
    const currentEvent = await this.findWebhookEventById(id);
    if (!currentEvent) {
      throw new Error('Webhook event not found');
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
    if (!row) {
      throw new Error('Failed to increment webhook event attempts');
    }
    return row as WebhookEvent;
  }

  // Analytics and reporting methods
  async getSubscriptionStats(
    startDate?: Instant,
    endDate?: Instant,
  ): Promise<SubscriptionWithRelations[]> {
    const createdAt =
      startDate || endDate
        ? { ...(startDate && { gte: startDate }), ...(endDate && { lte: endDate }) }
        : undefined;

    return this.q.subscriptions.findMany({
      where: createdAt ? { createdAt } : undefined,
      with: { plan: true },
    });
  }

  async getPaymentStats(startDate?: Instant, endDate?: Instant): Promise<PaymentWithRelations[]> {
    const createdAt =
      startDate || endDate
        ? { ...(startDate && { gte: startDate }), ...(endDate && { lte: endDate }) }
        : undefined;

    return this.q.payments.findMany({
      where: createdAt ? { createdAt } : undefined,
      with: { subscription: true },
    });
  }

  async getCustomerCount(): Promise<number> {
    const result = await this.db.select({ count: this.customers.id }).from(this.customers);
    return result.length;
  }

  async getActiveSubscriptionCount(): Promise<number> {
    const result = await this.db
      .select({ count: this.subscriptions.id })
      .from(this.subscriptions)
      .where(eq(this.subscriptions.status, 'active'));
    return result.length;
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
