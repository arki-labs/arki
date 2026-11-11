import type { AnyRelations, SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, count, desc, eq, gte, lt, lte, ne, or, sql } from 'drizzle-orm';

import type { UserId } from './user-id.js';
import type { Instant } from '@arki/date';
import { now } from '@arki/date';
import type { FailureOf, SchemaFailure } from '@arki/failure';
import { findDatabaseError } from '@arki/db/errors';
import { invariant, isFailure } from '@arki/failure';
import { is, parse } from '@arki/schema';

import type { PaymentQuery, PlanQuery, SubscriptionQuery } from './contracts.js';
import { paymentQuerySchema, planQuerySchema, subscriptionQuerySchema } from './contracts.js';
import { fitsIdColumn } from './id-length.js';
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
import { createCoreDerivedSchemas } from './derived-schemas.js';
import {
  CounterExhausted,
  CustomerConflict,
  CustomerInUse,
  PlanAlreadyExists,
  WebhookEventExists,
  WebhookEventNotFound,
} from './failures.js';
import { lockReferences } from './journal/support.js';
import { INT4_MAX, isPgInstant, pgTextSchema, pgVarcharSchema } from './pg-values.js';
import {
  paymentProviderValues,
  paymentStatusValues,
  planTierValues,
  subscriptionStatusValues,
  webhookEventTypeValues,
} from './primitives.js';
import { ReferenceNotFound } from './providers/provider-error.js';
import { claimWebhookEvent, reclaimWebhookEvent } from './webhook-claims.js';

type NotFound = FailureOf<typeof ReferenceNotFound>;
type EventNotFound = FailureOf<typeof WebhookEventNotFound>;
type Conflict = FailureOf<typeof CustomerConflict>;
type EventExists = FailureOf<typeof WebhookEventExists>;

/** SQLSTATE `foreign_key_violation`: a row still points at the one being deleted. */
const FOREIGN_KEY_VIOLATION = '23503';
/** SQLSTATE `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Whether a value is one of a pgEnum column's values. A lookup by any other value finds no row (Postgres would refuse it with a raw 22P02). */
function isEnumValue(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

/** A provider id a `varchar(255)` column can hold. A lookup by any other value finds no row. */
const providerIdSchema = pgVarcharSchema(255);

/**
 * The schemas the write methods check their input with: what each column can hold, so a value
 * Postgres would refuse comes back as `InvalidInput` (`schema.invalid_input`), never a raw error.
 * The methods then write the typed input itself, as given.
 * `errorMessage` and `sourceIp` take any text their column holds: the insert contract's length cap
 * and IP pattern are for API input.
 */
function buildWriteSchemas(tables: Pick<CoreTables, 'plans' | 'customers' | 'subscriptions' | 'payments' | 'webhookEvents'>) {
  const derived = createCoreDerivedSchemas(tables);
  const webhookEvent = derived.webhookEventInsertSchema.extend({
    errorMessage: pgTextSchema.nullable().optional(),
    sourceIp: pgVarcharSchema(45).nullable().optional(),
  });
  return {
    newPlan: derived.planInsertSchema,
    planChange: derived.planInsertSchema.partial().omit({ id: true }),
    newCustomer: derived.customerInsertSchema,
    customerChange: derived.customerInsertSchema.partial().omit({ id: true }),
    newWebhookEvent: webhookEvent,
    webhookEventChange: webhookEvent.partial().omit({ id: true }),
  };
}

/** The precondition of a read bounded by a time: an `instant` column compares only with years 1 to 9999. */
function assertComparable(value: Instant | undefined, name: string): void {
  invariant(value === undefined || isPgInstant(value), () => `[@arki/payments] ${name} must fall in the years 1 to 9999`);
}

/** The precondition of a row count or a page size: a whole number Postgres takes in LIMIT. */
function assertCount(value: number, name: string): void {
  invariant(Number.isSafeInteger(value) && value >= 0, () => `[@arki/payments] ${name} must be a whole number of 0 or more`);
}

/**
 * Whether a row could hold every given id. Postgres stores no U+0000 in text, and an id column holds at
 * most `ID_COLUMN_LENGTH` characters, so a lookup by such an id finds no row; the methods answer it as
 * "not found" without a query (U+0000 would fail with a raw SQLSTATE 22021, and a list query's schema
 * refuses the long id). Typed ids (`pln_…`, `usr_…`) are caller text too.
 */
function findable(...ids: (string | undefined)[]): boolean {
  return ids.every(id => id === undefined || (is(id, pgTextSchema) && fitsIdColumn(id)));
}

/** The precondition of a list query: a value its contract schema accepts (whole `limit` 1 to 100, `offset` 0 or more, times in the years 1 to 9999). */
function assertQuery(accepted: boolean, name: string): void {
  invariant(accepted, () => `[@arki/payments] ${name} must be a value its contract schema accepts`);
}

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
  private readonly writeSchemas: ReturnType<typeof buildWriteSchemas>;

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
    this.writeSchemas = buildWriteSchemas(tables);
  }

  // Plan methods
  /**
   * The new plan. `InvalidInput` when a value does not fit its column (a negative or fractional
   * price, a currency outside ISO 4217, text with U+0000 or past its length, an interval count or
   * trial past 365 days); `PlanAlreadyExists` when a plan has `data.id`. Nothing is written then.
   */
  async createPlan(data: NewPlan): Promise<Plan | SchemaFailure | FailureOf<typeof PlanAlreadyExists>> {
    const checked = parse(this.writeSchemas.newPlan, data);
    if (isFailure(checked)) return checked;
    const [row] = await this.db.insert(this.plans).values(data).onConflictDoNothing({ target: this.plans.id }).returning();
    if (row) return row;
    // No row back: the id was taken, or something in the database (a trigger) dropped the insert
    invariant(data.id !== undefined && (await this.findPlanById(data.id)), 'Failed to create plan');
    return PlanAlreadyExists({ planId: data.id });
  }

  /** Null too for an id no row can hold (U+0000, or longer than an id column), with no query. */
  async findPlanById(id: PlanId): Promise<Plan | null> {
    if (!findable(id)) return null;
    const [plan] = await this.db.select().from(this.plans).where(eq(this.plans.id, id)).limit(1);
    return plan ?? null;
  }

  /** Empty for a tier outside `planTierValues`, with no query. */
  async findPlansByTier(tier: PlanTier): Promise<Plan[]> {
    if (!isEnumValue(planTierValues, tier)) return [];
    return this.db
      .select()
      .from(this.plans)
      .where(and(eq(this.plans.tier, tier), eq(this.plans.isActive, true)))
      .orderBy(this.plans.priceMinor);
  }

  /**
   * Plans matching the filters left in `query`, cheapest first within a tier, one page. `query` is a
   * value `planQuerySchema` accepts (a precondition: anything else, such as a fractional `limit`, throws
   * an invariant failure before any query).
   */
  async findPlans(query: PlanQuery): Promise<Plan[]> {
    assertQuery(is(query, planQuerySchema), 'findPlans query');
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

  /**
   * The updated plan, `ReferenceNotFound` when no plan has this id, or `InvalidInput` when a value
   * does not fit its column (the rules of `createPlan`).
   */
  async updatePlan(id: PlanId, data: UpdatePlan): Promise<Plan | NotFound | SchemaFailure> {
    const checked = parse(this.writeSchemas.planChange, data);
    if (isFailure(checked)) return checked;
    if (!findable(id)) return ReferenceNotFound({ kind: 'plan', id, missing: 'row' });
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

  /** The deactivated plan, or `ReferenceNotFound` when no plan has this id (or it holds U+0000: no query then). */
  async deactivatePlan(id: PlanId): Promise<Plan | NotFound> {
    if (!findable(id)) return ReferenceNotFound({ kind: 'plan', id, missing: 'row' });
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
   *
   * `ReferenceNotFound` (kind `user`) when no user has `data.userId`, and `InvalidInput` when a value
   * does not fit its column (an email that is not an address or past 255 characters, text with
   * U+0000). Nothing is written then.
   */
  async createCustomer(data: NewCustomer): Promise<Customer | Conflict | NotFound | SchemaFailure> {
    const checked = parse(this.writeSchemas.newCustomer, data);
    if (isFailure(checked)) return checked;
    const values = data;

    return this.db.transaction(async tx => {
      const missing = await lockReferences(tx, this.customers, [
        {
          column: this.customers.userId,
          value: values.userId,
          missing: () => ReferenceNotFound({ kind: 'user', id: values.userId, missing: 'row' }),
        },
      ]);
      if (missing) return missing;

      const [created] = await tx.insert(this.customers).values(values).onConflictDoNothing().returning();
      if (created) return created;

      const [existing] = await tx.select().from(this.customers).where(eq(this.customers.userId, values.userId)).limit(1);
      if (existing && existing.providerCustomerId === values.providerCustomerId) return existing;

      return CustomerConflict({
        userId: values.userId,
        providerCustomerId: values.providerCustomerId,
        existingCustomerId: existing?.id ?? null,
      });
    });
  }

  /** Null too for an id no row can hold (U+0000, or longer than an id column), with no query. */
  async findCustomerById(id: CustomerId): Promise<Customer | null> {
    if (!findable(id)) return null;
    const [customer] = await this.db.select().from(this.customers).where(eq(this.customers.id, id)).limit(1);
    return customer ?? null;
  }

  /** Null too for a user id no row can hold (U+0000, or longer than an id column), with no query. */
  async findCustomerByUserId(userId: UserId): Promise<Customer | null> {
    if (!findable(userId)) return null;
    const [customer] = await this.db
      .select()
      .from(this.customers)
      .where(eq(this.customers.userId, userId))
      .limit(1);
    return customer ?? null;
  }

  /** Null too for an id no row can hold (U+0000, or past 255 characters), or a provider outside `paymentProviderValues`. */
  async findCustomerByProviderCustomerId(
    providerCustomerId: string,
    provider: PaymentProviderType,
  ): Promise<Customer | null> {
    if (!providerIdSchema.safeParse(providerCustomerId).success) return null;
    if (!isEnumValue(paymentProviderValues, provider)) return null;
    const [customer] = await this.db
      .select()
      .from(this.customers)
      .where(and(eq(this.customers.providerCustomerId, providerCustomerId), eq(this.customers.provider, provider)))
      .limit(1);
    return customer ?? null;
  }

  /**
   * The updated customer. `ReferenceNotFound` when no customer has this id (kind `customer`) or no
   * user has `data.userId` (kind `user`); `CustomerConflict` when the new `userId` already has
   * another customer, or the new provider customer id belongs to another customer; `InvalidInput`
   * when a value does not fit its column. Nothing is written then.
   */
  async updateCustomer(id: CustomerId, data: UpdateCustomer): Promise<Customer | NotFound | Conflict | SchemaFailure> {
    const checked = parse(this.writeSchemas.customerChange, data);
    if (isFailure(checked)) return checked;
    if (!findable(id)) return ReferenceNotFound({ kind: 'customer', id, missing: 'row' });
    const changes = data;

    return this.db.transaction(async tx => {
      const [current] = await tx.select().from(this.customers).where(eq(this.customers.id, id)).for('update');
      if (!current) return ReferenceNotFound({ kind: 'customer', id, missing: 'row' });
      const missing = await lockReferences(tx, this.customers, [
        {
          column: this.customers.userId,
          value: changes.userId,
          missing: () => ReferenceNotFound({ kind: 'user', id: String(changes.userId), missing: 'row' }),
        },
      ]);
      if (missing) return missing;

      // The two unique indexes, checked against every other customer
      const userId = changes.userId ?? current.userId;
      const providerCustomerId = changes.providerCustomerId ?? current.providerCustomerId;
      const provider = changes.provider ?? current.provider;
      const clashWith = and(
        ne(this.customers.id, id),
        or(
          eq(this.customers.userId, userId),
          and(eq(this.customers.provider, provider), eq(this.customers.providerCustomerId, providerCustomerId)),
        ),
      );
      const [clash] = await tx
        .select({ id: this.customers.id, userId: this.customers.userId })
        .from(this.customers)
        .where(clashWith)
        .limit(1);
      if (clash) {
        return CustomerConflict({
          userId,
          providerCustomerId,
          existingCustomerId: clash.userId === userId ? clash.id : null,
        });
      }

      try {
        // A savepoint: a customer that took the same user or provider id meanwhile (a 23505) leaves the transaction usable
        const [row] = await tx.transaction(async savepoint =>
          savepoint.update(this.customers).set({ ...changes, updatedAt: now() }).where(eq(this.customers.id, id)).returning(),
        );
        invariant(row, 'The customer row was locked above');
        return row;
      } catch (error) {
        if (findDatabaseError(error)?.sqlState !== UNIQUE_VIOLATION) throw error;
        const [taken] = await tx.select({ id: this.customers.id, userId: this.customers.userId }).from(this.customers).where(clashWith).limit(1);
        if (!taken) throw error;
        return CustomerConflict({ userId, providerCustomerId, existingCustomerId: taken.userId === userId ? taken.id : null });
      }
    });
  }

  /**
   * Deletes the customer, with its subscriptions and payments (their foreign keys cascade). An
   * unknown id deletes nothing. `CustomerInUse` when a row that does not cascade still points at the
   * customer or one of its payments (a refund): nothing is deleted then.
   */
  async deleteCustomer(id: CustomerId): Promise<undefined | FailureOf<typeof CustomerInUse>> {
    // An id no row can hold (U+0000, or longer than an id column) deletes nothing, like any unknown id
    if (!findable(id)) return undefined;
    try {
      // A savepoint inside a caller's transaction, so a refused delete leaves that transaction usable
      await this.db.transaction(async tx => {
        await tx.delete(this.customers).where(eq(this.customers.id, id));
      });
      return undefined;
    } catch (error) {
      if (findDatabaseError(error)?.sqlState === FOREIGN_KEY_VIOLATION) return CustomerInUse({ customerId: id });
      throw error;
    }
  }

  // Subscription methods
  /** Null too for an id no row can hold (U+0000, or longer than an id column), with no query. */
  async findSubscriptionById(id: SubscriptionId): Promise<SubscriptionWithPlan | null> {
    if (!findable(id)) return null;
    const [subscription] = await this.readSubscriptions({ where: eq(this.subscriptions.id, id), limit: 1 });
    return subscription ?? null;
  }

  /** Empty too for a user id no row can hold (U+0000, or longer than an id column), with no query. */
  async findSubscriptionsByUserId(userId: UserId): Promise<Subscription[]> {
    if (!findable(userId)) return [];
    return this.readSubscriptions({
      where: eq(this.subscriptions.userId, userId),
      orderBy: [desc(this.subscriptions.createdAt)],
    });
  }

  /**
   * Subscriptions matching the filters left in `query`, newest first, one page. Empty for an id no row
   * can hold (U+0000, or longer than an id column), with no query. Otherwise `query` is a value `subscriptionQuerySchema` accepts (a
   * precondition: anything else, such as a fractional `limit`, throws an invariant failure before any query).
   */
  async findSubscriptions(query: SubscriptionQuery): Promise<Subscription[]> {
    const { status, planId, userId, limit, offset } = query;
    if (!findable(planId, userId)) return [];
    assertQuery(is(query, subscriptionQuerySchema), 'findSubscriptions query');

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

  /** Null too for a user id no row can hold (U+0000, or longer than an id column), with no query. */
  async findActiveSubscriptionByUserId(userId: UserId): Promise<SubscriptionWithPlan | null> {
    if (!findable(userId)) return null;
    const [subscription] = await this.readSubscriptions({
      where: and(eq(this.subscriptions.userId, userId), eq(this.subscriptions.status, 'active')),
      limit: 1,
    });
    return subscription ?? null;
  }

  /** Null too for an id no row can hold (U+0000, or past 255 characters). */
  async findSubscriptionByProviderSubscriptionId(
    providerSubscriptionId: string,
  ): Promise<Subscription | null> {
    if (!providerIdSchema.safeParse(providerSubscriptionId).success) return null;
    const [subscription] = await this.readSubscriptions({
      where: eq(this.subscriptions.providerSubscriptionId, providerSubscriptionId),
      limit: 1,
    });
    return subscription ?? null;
  }

  /** Empty for a status outside `subscriptionStatusValues`, with no query. */
  async findSubscriptionsByStatus(status: SubscriptionStatus): Promise<Subscription[]> {
    if (!isEnumValue(subscriptionStatusValues, status)) return [];
    return this.readSubscriptions({
      where: eq(this.subscriptions.status, status),
      orderBy: [desc(this.subscriptions.createdAt)],
    });
  }

  /**
   * Subscriptions in `status` (`active` when left out) whose current period ends between the two
   * times, both included. Empty for a status outside `subscriptionStatusValues`, with no query. Both times must fall in the years 1 to 9999 (a precondition: anything
   * else throws).
   */
  async findSubscriptionsEndingInRange(
    startDate: Instant,
    endDate: Instant,
    status: SubscriptionStatus = 'active',
  ): Promise<Subscription[]> {
    assertComparable(startDate, 'startDate');
    assertComparable(endDate, 'endDate');
    if (!isEnumValue(subscriptionStatusValues, status)) return [];
    return this.readSubscriptions({
      where: and(
        gte(this.subscriptions.currentPeriodEnd, startDate),
        lte(this.subscriptions.currentPeriodEnd, endDate),
        eq(this.subscriptions.status, status),
      ),
      orderBy: [this.subscriptions.currentPeriodEnd],
    });
  }

  async getSubscription(id: SubscriptionId): Promise<Subscription | null> {
    return this.findSubscriptionById(id);
  }

  // Payment methods
  /** Null too for an id no row can hold (U+0000, or longer than an id column), with no query. */
  async findPaymentById(id: PaymentId): Promise<Payment | null> {
    if (!findable(id)) return null;
    const [payment] = await this.readPayments({ where: eq(this.payments.id, id), limit: 1 });
    return payment ?? null;
  }

  /**
   * The newest `limit` payments of the user; empty for a user id no row can hold (U+0000, or longer than an id column). `limit` is a
   * whole number of 0 or more (a precondition: anything else throws).
   */
  async findPaymentsByUserId(userId: UserId, limit = 50): Promise<Payment[]> {
    assertCount(limit, 'limit');
    if (!findable(userId)) return [];
    return this.readPayments({
      where: eq(this.payments.userId, userId),
      orderBy: [desc(this.payments.createdAt)],
      limit,
    });
  }

  /**
   * Payments matching the filters left in `query`, newest first, one page. `startDate` and `endDate` bound
   * `createdAt`, both inclusive. Empty for an id no row can hold (U+0000, or longer than an id column), with no query. Otherwise
   * `query` is a value `paymentQuerySchema` accepts (a precondition: anything else, such as a fractional
   * `limit` or a time outside the years 1 to 9999, throws an invariant failure before any query).
   */
  async findPayments(query: PaymentQuery): Promise<Payment[]> {
    const { status, subscriptionId, customerId, userId, startDate, endDate, limit, offset } = query;
    if (!findable(subscriptionId, customerId, userId)) return [];
    assertQuery(is(query, paymentQuerySchema), 'findPayments query');

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

  /** Empty too for an id no row can hold (U+0000, or longer than an id column), with no query. */
  async findPaymentsBySubscriptionId(subscriptionId: SubscriptionId): Promise<Payment[]> {
    if (!findable(subscriptionId)) return [];
    return this.readPayments({
      where: eq(this.payments.subscriptionId, subscriptionId),
      orderBy: [desc(this.payments.createdAt)],
    });
  }

  /** Null too for an id no row can hold (U+0000, or past 255 characters). */
  async findPaymentByProviderPaymentId(providerPaymentId: string): Promise<Payment | null> {
    if (!providerIdSchema.safeParse(providerPaymentId).success) return null;
    const [payment] = await this.readPayments({
      where: eq(this.payments.providerPaymentId, providerPaymentId),
      limit: 1,
    });
    return payment ?? null;
  }

  /** Empty for a status outside `paymentStatusValues`, with no query. */
  async findPaymentsByStatus(status: PaymentStatus): Promise<Payment[]> {
    if (!isEnumValue(paymentStatusValues, status)) return [];
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
  /**
   * The new event. `WebhookEventExists` when another event holds its provider event id or its id,
   * and `InvalidInput` when a value does not fit its column (an id past 255 characters, U+0000 in
   * text or in `data`, a `sourceIp` past 45 characters). Nothing is written then. A delivery handler
   * uses `claimWebhookEvent` instead, which hands back the stored copy.
   */
  async createWebhookEvent(data: NewWebhookEvent): Promise<WebhookEvent | EventExists | SchemaFailure> {
    const checked = parse(this.writeSchemas.newWebhookEvent, data);
    if (isFailure(checked)) return checked;
    const [row] = await this.db.insert(this.webhookEvents).values(data).onConflictDoNothing().returning();
    return row ?? WebhookEventExists({ providerEventId: data.providerEventId });
  }

  /**
   * Insert the event, or return the row that holds its id. See `claimWebhookEvent` in `webhook-claims.ts`,
   * which also returns `InvalidInput` when a value does not fit its column.
   */
  async claimWebhookEvent(data: NewWebhookEvent): ReturnType<typeof claimWebhookEvent> {
    return claimWebhookEvent(this.db, this.webhookEvents, data);
  }

  /**
   * Take over a failed or stale unprocessed event. See `reclaimWebhookEvent` in `webhook-claims.ts`:
   * `seenAttempts` is the whole `attempts` value read from the row, and `leaseCutoff` falls in the
   * years 1 to 9999 (preconditions: anything else throws).
   */
  async reclaimWebhookEvent(id: WebhookId, seenAttempts: number, leaseCutoff: Instant) {
    return reclaimWebhookEvent(this.db, this.webhookEvents, id, seenAttempts, leaseCutoff);
  }

  /** Null too for an id no row can hold (U+0000, or longer than an id column), with no query. */
  async findWebhookEventById(id: WebhookId): Promise<WebhookEvent | null> {
    if (!findable(id)) return null;
    const [webhookEvent] = await this.db
      .select()
      .from(this.webhookEvents)
      .where(eq(this.webhookEvents.id, id))
      .limit(1);
    return webhookEvent ?? null;
  }

  /** Null too for an id no row can hold (U+0000, or past 255 characters), or a provider outside `paymentProviderValues`. */
  async findWebhookEventByProviderEventId(
    providerEventId: string,
    provider: PaymentProviderType,
  ): Promise<WebhookEvent | null> {
    if (!providerIdSchema.safeParse(providerEventId).success) return null;
    if (!isEnumValue(paymentProviderValues, provider)) return null;
    const [webhookEvent] = await this.db
      .select()
      .from(this.webhookEvents)
      .where(and(eq(this.webhookEvents.providerEventId, providerEventId), eq(this.webhookEvents.provider, provider)))
      .limit(1);
    return webhookEvent ?? null;
  }

  /**
   * The oldest `limit` unprocessed events; with `belowAttempts`, only those with fewer attempts.
   * Both are whole numbers of 0 or more (a precondition: anything else throws). A `belowAttempts` past
   * the 32-bit integer range matches every event, as the `attempts` column cannot hold more.
   */
  async findUnprocessedWebhookEvents(limit = 100, belowAttempts?: number): Promise<WebhookEvent[]> {
    assertCount(limit, 'limit');
    if (belowAttempts !== undefined) assertCount(belowAttempts, 'belowAttempts');
    return this.db
      .select()
      .from(this.webhookEvents)
      .where(
        and(
          eq(this.webhookEvents.processed, false),
          belowAttempts === undefined || belowAttempts > INT4_MAX ? undefined : lt(this.webhookEvents.attempts, belowAttempts),
        ),
      )
      .orderBy(this.webhookEvents.createdAt)
      .limit(limit);
  }

  /**
   * The newest `limit` events, processed or not, created between the two times (both included, each
   * optional). A time given falls in the years 1 to 9999, and `limit` is a whole number of 0 or more
   * (preconditions: anything else throws).
   */
  async findWebhookEventsCreatedBetween(startDate?: Instant, endDate?: Instant, limit = 1000): Promise<WebhookEvent[]> {
    assertComparable(startDate, 'startDate');
    assertComparable(endDate, 'endDate');
    assertCount(limit, 'limit');
    return this.db
      .select()
      .from(this.webhookEvents)
      .where(
        and(
          startDate ? gte(this.webhookEvents.createdAt, startDate) : undefined,
          endDate ? lte(this.webhookEvents.createdAt, endDate) : undefined,
        ),
      )
      .orderBy(desc(this.webhookEvents.createdAt))
      .limit(limit);
  }

  /** Empty for a type outside `webhookEventTypeValues`, with no query. */
  async findWebhookEventsByType(eventType: WebhookEventType): Promise<WebhookEvent[]> {
    if (!isEnumValue(webhookEventTypeValues, eventType)) return [];
    return this.db
      .select()
      .from(this.webhookEvents)
      .where(eq(this.webhookEvents.eventType, eventType))
      .orderBy(desc(this.webhookEvents.createdAt));
  }

  /**
   * The updated event. `WebhookEventNotFound` when no event has this id, `WebhookEventExists` when
   * another event holds the new provider event id, and `InvalidInput` when a value does not fit its
   * column (the rules of `createWebhookEvent`). Nothing is written then.
   */
  async updateWebhookEvent(
    id: WebhookId,
    data: UpdateWebhookEvent,
  ): Promise<WebhookEvent | EventNotFound | EventExists | SchemaFailure> {
    const checked = parse(this.writeSchemas.webhookEventChange, data);
    if (isFailure(checked)) return checked;
    if (!findable(id)) return WebhookEventNotFound({ webhookId: id });
    const changes = data;
    try {
      // A savepoint inside a caller's transaction, so a refused update leaves that transaction usable
      const [row] = await this.db.transaction(async tx =>
        tx
          .update(this.webhookEvents)
          .set({ ...changes, updatedAt: now() })
          .where(eq(this.webhookEvents.id, id))
          .returning(),
      );
      return row ?? WebhookEventNotFound({ webhookId: id });
    } catch (error) {
      if (findDatabaseError(error)?.sqlState !== UNIQUE_VIOLATION || changes.providerEventId === undefined) throw error;
      return WebhookEventExists({ providerEventId: changes.providerEventId });
    }
  }

  /** The processed event, or `WebhookEventNotFound` when no event has this id. */
  async markWebhookEventAsProcessed(id: WebhookId): Promise<WebhookEvent | EventNotFound> {
    if (!findable(id)) return WebhookEventNotFound({ webhookId: id });
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

  /**
   * The event with one more attempt, `WebhookEventNotFound` when no event has this id,
   * `CounterExhausted` (`payments.counter_exhausted`) when its `attempts` already holds `INT4_MAX`, or
   * `InvalidInput` when `errorMessage` holds U+0000 (nothing is written for either failure).
   */
  async incrementWebhookEventAttempts(
    id: WebhookId,
    errorMessage?: string,
  ): Promise<WebhookEvent | EventNotFound | FailureOf<typeof CounterExhausted> | SchemaFailure> {
    const message = parse(pgTextSchema.optional(), errorMessage);
    if (isFailure(message)) return message;
    if (!findable(id)) return WebhookEventNotFound({ webhookId: id });

    const events = this.webhookEvents;
    const [row] = await this.db
      .update(events)
      .set({
        // Raised in SQL, so two calls at once count two attempts
        attempts: sql`${events.attempts} + 1`,
        lastAttemptAt: now(),
        errorMessage: message,
        updatedAt: now(),
      })
      // The guard sits in the update itself, so a full count is never raised past what the column holds
      .where(and(eq(events.id, id), lt(events.attempts, INT4_MAX)))
      .returning();
    if (row) return row;

    // Nothing matched: an unknown id, or an event whose count is full
    const existing = await this.findWebhookEventById(id);
    return existing ? CounterExhausted({ counter: 'attempts', id }) : WebhookEventNotFound({ webhookId: id });
  }

  // Analytics and reporting methods
  /** Subscriptions created between the two times, both included. A time given falls in the years 1 to 9999 (a precondition: anything else throws). */
  async getSubscriptionStats(
    startDate?: Instant,
    endDate?: Instant,
  ): Promise<SubscriptionWithRelations[]> {
    assertComparable(startDate, 'startDate');
    assertComparable(endDate, 'endDate');
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

  /** Payments created between the two times, both included. A time given falls in the years 1 to 9999 (a precondition: anything else throws). */
  async getPaymentStats(startDate?: Instant, endDate?: Instant): Promise<PaymentWithRelations[]> {
    assertComparable(startDate, 'startDate');
    assertComparable(endDate, 'endDate');
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

  /** How many payments were created from `start` (included) to `end` (excluded). Both fall in the years 1 to 9999 (a precondition: anything else throws). */
  async countPaymentsCreatedBetween(start: Instant, end: Instant): Promise<number> {
    assertComparable(start, 'start');
    assertComparable(end, 'end');
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
