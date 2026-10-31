import type { SQL } from 'drizzle-orm';
import { and, eq, sql } from 'drizzle-orm';

import type { Instant } from '@arki/date';
import { now, toMillis } from '@arki/date';
import { getLogger } from '@arki/log';
import type { FailureOf } from '@arki/failure';
import { invariant, isFailure } from '@arki/failure';
import type { MoneyFailure } from '@arki/money';
import { Money } from '@arki/money';

import type { CoreTables } from '../../core/tables.js';
import type { Customer, CustomerId } from '../../core/types.js';
import type { CreateCustomerSegmentInput, ListCustomerSegmentsQuery, UpdateCustomerSegmentInput } from '../contracts.js';
import type { CustomerSegmentId } from '../primitives.js';
import type { DunningDatabase } from '../repository.js';
import type { DunningTables } from '../tables.js';
import type {
  CustomerRiskProfile,
  CustomerSegment,
  RiskScore,
  SegmentCriteria,
} from '../types.js';
import { toMinorColumn } from '../../core/money.js';
import type { DunningTickReport } from '../failures.js';
import { CustomerSegmentNotFound, tickFault } from '../failures.js';
import { createCustomerRiskProfileRepository, createCustomerSegmentRepository } from '../repository.js';
import { valueList } from '../sql-list.js';

const logger = getLogger('arki:payments:dunning');

/** The customer columns a segment listing returns. */
export type SegmentCustomer = Pick<Customer, 'id' | 'userId' | 'email' | 'name' | 'createdAt'>;

type StoredPaymentHistory = CustomerRiskProfile['paymentHistory'];
type StoredSubscriptionHistory = CustomerRiskProfile['subscriptionHistory'];
type StoredEngagementMetrics = CustomerRiskProfile['engagementMetrics'];


// Utility functions removed in favor of Drizzle types

/**
 * Service for customer segmentation and risk scoring
 * Handles segment management, customer classification, and risk assessment
 */
export type SegmentationCoreTables = Pick<CoreTables, 'customers' | 'payments' | 'subscriptions' | 'plans'>;
export type SegmentationDunningTables = Pick<DunningTables, 'customerSegments' | 'customerRiskProfiles'>;

export class CustomerSegmentationService {
  private segmentRepo;
  private riskProfileRepo;
  private readonly customers: CoreTables['customers'];
  private readonly payments: CoreTables['payments'];
  private readonly subscriptions: CoreTables['subscriptions'];
  private readonly plans: CoreTables['plans'];

  constructor(
    private readonly db: DunningDatabase,
    coreTables: SegmentationCoreTables,
    dunningTables: SegmentationDunningTables,
  ) {
    this.segmentRepo = createCustomerSegmentRepository(db, {
      customerSegments: dunningTables.customerSegments,
    });
    this.riskProfileRepo = createCustomerRiskProfileRepository(db, {
      customerRiskProfiles: dunningTables.customerRiskProfiles,
    });
    this.customers = coreTables.customers;
    this.payments = coreTables.payments;
    this.subscriptions = coreTables.subscriptions;
    this.plans = coreTables.plans;
  }

  /**
   * Create a new customer segment. The criteria are checked first: a spend range that is not valid money
   * returns its `MoneyFailure` and nothing is written. After a good write, the count can only fail with a
   * database error, which throws (this service holds no transaction, so the saved row stays).
   */
  async createSegment(
    input: CreateCustomerSegmentInput,
    createdBy: string,
  ): Promise<CustomerSegment | MoneyFailure | FailureOf<typeof CustomerSegmentNotFound>> {
    const valid = this.buildSegmentConditions(input.criteria);
    if (isFailure(valid)) return valid;

    const dbSegment = await this.segmentRepo.create({
      ...input,
      createdBy,
    });

    invariant(dbSegment, 'the segment insert returned no row');

    const segment = dbSegment;

    // Calculate initial customer count if auto-update is enabled
    if (input.autoUpdate) {
      const counted = await this.updateSegmentCustomerCount(segment.id);
      if (isFailure(counted)) return counted;
    }

    return segment;
  }

  /**
   * Update an existing segment. As in `createSegment`, new criteria with a spend range that is not valid
   * money return their `MoneyFailure` before anything is written.
   */
  async updateSegment(
    segmentId: CustomerSegmentId,
    input: UpdateCustomerSegmentInput,
  ): Promise<CustomerSegment | null | MoneyFailure | FailureOf<typeof CustomerSegmentNotFound>> {
    if (input.criteria) {
      const valid = this.buildSegmentConditions(input.criteria);
      if (isFailure(valid)) return valid;
    }

    const dbSegment = await this.segmentRepo.update(segmentId, input);

    if (!dbSegment) {
      return null;
    }

    const segment = dbSegment;

    // Recalculate customer count if criteria changed
    if (input.criteria) {
      const counted = await this.updateSegmentCustomerCount(segment.id);
      if (isFailure(counted)) return counted;
    }

    return segment;
  }

  /**
   * Get segment by ID
   */
  async getSegment(segmentId: CustomerSegmentId): Promise<CustomerSegment | null> {
    const dbSegment = await this.segmentRepo.findById(segmentId);
    return dbSegment ?? null;
  }

  /**
   * List segments with filtering and pagination
   */
  async listSegments(query: ListCustomerSegmentsQuery): Promise<CustomerSegment[]> {
    const dbSegments = await this.segmentRepo.findMany(query);
    return dbSegments;
  }

  /**
   * Delete a segment
   */
  async deleteSegment(segmentId: CustomerSegmentId): Promise<void> {
    await this.segmentRepo.delete(segmentId);
  }

  /**
   * Calculate and update customer count for a segment, and return the new count. An unknown segment returns
   * `CustomerSegmentNotFound`; a stored spend range that is not valid money returns its `MoneyFailure`.
   */
  async updateSegmentCustomerCount(segmentId: CustomerSegmentId) {
    const dbSegment = await this.segmentRepo.findById(segmentId);
    if (!dbSegment) {
      return CustomerSegmentNotFound({ segmentId });
    }

    const segment = dbSegment;
    const customerCount = await this.calculateSegmentCustomerCount(segment.criteria);
    if (isFailure(customerCount)) return customerCount;
    await this.segmentRepo.updateCustomerCount(segmentId, customerCount);
    return customerCount;
  }

  /**
   * Calculate customer count for segment criteria
   */
  private async calculateSegmentCustomerCount(criteria: SegmentCriteria): Promise<number | MoneyFailure> {
    const conditions = this.buildSegmentConditions(criteria);
    if (isFailure(conditions)) return conditions;

    const result =
      conditions.length > 0
        ? await this.db
            .select({ count: sql<number>`COUNT(DISTINCT ${this.customers.id})`.mapWith(Number) })
            .from(this.customers)
            .where(conditions.length === 1 ? conditions[0] : and(...conditions))
        : await this.db.select({ count: sql<number>`COUNT(DISTINCT ${this.customers.id})`.mapWith(Number) }).from(this.customers);

    return result[0]?.count ?? 0;
  }

  /**
   * Get customers matching segment criteria. An unknown segment returns `CustomerSegmentNotFound`.
   */
  async getCustomersInSegment(segmentId: CustomerSegmentId, limit = 100) {
    const dbSegment = await this.segmentRepo.findById(segmentId);
    if (!dbSegment) {
      return CustomerSegmentNotFound({ segmentId });
    }

    const segment = dbSegment;
    return this.getCustomersMatchingCriteria(segment.criteria, limit);
  }

  /**
   * Get customers matching specific criteria
   */
  async getCustomersMatchingCriteria(criteria: SegmentCriteria, limit = 100): Promise<SegmentCustomer[] | MoneyFailure> {
    const conditions = this.buildSegmentConditions(criteria);
    if (isFailure(conditions)) return conditions;

    const result =
      conditions.length > 0
        ? await this.db
            .select({
              id: this.customers.id,
              userId: this.customers.userId,
              email: this.customers.email,
              name: this.customers.name,
              createdAt: this.customers.createdAt,
            })
            .from(this.customers)
            .where(conditions.length === 1 ? conditions[0] : and(...conditions))
            .limit(limit)
        : await this.db
            .select({
              id: this.customers.id,
              userId: this.customers.userId,
              email: this.customers.email,
              name: this.customers.name,
              createdAt: this.customers.createdAt,
            })
            .from(this.customers)
            .limit(limit);

    return result;
  }

  /**
   * Build SQL conditions from segment criteria. The spend range comes from a stored jsonb column, so
   * an amount `@arki/money` refuses is returned as that `MoneyFailure`, never turned into a wrong filter.
   */
  private buildSegmentConditions(criteria: SegmentCriteria): SQL[] | MoneyFailure {
    const conditions: SQL[] = [];

    // Total spent criteria: only payments in the range's currency count, compared in minor units
    // (summing USD and EUR into one number would be meaningless).
    const spendBound = criteria.totalSpent?.min ?? criteria.totalSpent?.max;
    if (criteria.totalSpent && spendBound) {
      const bound = Money.fromJSON(spendBound);
      if (isFailure(bound)) return bound;
      const min = criteria.totalSpent.min === undefined ? undefined : Money.fromJSON(criteria.totalSpent.min);
      if (isFailure(min)) return min;
      const max = criteria.totalSpent.max === undefined ? undefined : Money.fromJSON(criteria.totalSpent.max);
      if (isFailure(max)) return max;
      const totalSpentSubquery = this.db
        .select({ customerId: this.payments.customerId, total: sql<string>`SUM(${this.payments.amountMinor})`.as('total') })
        .from(this.payments)
        .where(
          and(
            eq(this.payments.status, 'succeeded'),
            eq(this.payments.currency, bound.currency.code),
          ),
        )
        .groupBy(this.payments.customerId);

      if (min !== undefined) {
        conditions.push(
          sql`
            ${this.customers.id} IN (
                        SELECT customer_id FROM (${totalSpentSubquery}) AS totals
                        WHERE total >= ${toMinorColumn(min)}
                      )
          `,
        );
      }

      if (max !== undefined) {
        conditions.push(
          sql`
            ${this.customers.id} IN (
                        SELECT customer_id FROM (${totalSpentSubquery}) AS totals
                        WHERE total <= ${toMinorColumn(max)}
                      )
          `,
        );
      }
    }

    // Subscription duration criteria
    if (criteria.subscriptionDuration) {
      if (criteria.subscriptionDuration.min !== undefined) {
        const minDate = new Date();
        minDate.setMonth(minDate.getMonth() - criteria.subscriptionDuration.min);

        conditions.push(
          sql`
            ${this.customers.id} IN (
                        SELECT customer_id FROM ${this.subscriptions}
                        WHERE created_at <= ${minDate}
                      )
          `,
        );
      }

      if (criteria.subscriptionDuration.max !== undefined) {
        const maxDate = new Date();
        maxDate.setMonth(maxDate.getMonth() - criteria.subscriptionDuration.max);

        conditions.push(
          sql`
            ${this.customers.id} IN (
                        SELECT customer_id FROM ${this.subscriptions}
                        WHERE created_at >= ${maxDate}
                      )
          `,
        );
      }
    }

    // Payment failure history criteria
    if (criteria.paymentFailureHistory) {
      const timeframeDate = new Date();
      timeframeDate.setDate(timeframeDate.getDate() - criteria.paymentFailureHistory.timeframe);

      conditions.push(
        sql`
          ${this.customers.id} IN (
                    SELECT customer_id FROM ${this.payments}
                    WHERE status = 'failed'
                      AND created_at >= ${timeframeDate}
                    GROUP BY customer_id
                    HAVING COUNT(*) >= ${criteria.paymentFailureHistory.count}
                  )
        `,
      );
    }

    // Plan tier criteria
    if (criteria.planTier && criteria.planTier.length > 0) {
      conditions.push(
        sql`
          ${this.customers.id} IN (
                    SELECT s.customer_id FROM ${this.subscriptions} s
                    JOIN ${this.plans} p ON s.plan_id = p.id
                    WHERE p.tier IN ${valueList(criteria.planTier)}
                  )
        `,
      );
    }

    // Last payment date criteria
    if (criteria.lastPaymentDate) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - criteria.lastPaymentDate.daysAgo);

      conditions.push(
        sql`
          ${this.customers.id} IN (
                    SELECT customer_id FROM ${this.payments}
                    WHERE status = 'succeeded'
                      AND created_at >= ${cutoffDate}
                  )
        `,
      );
    }

    return conditions;
  }

  /**
   * Calculate risk score for a customer
   */
  async calculateCustomerRiskScore(customerId: CustomerId): Promise<RiskScore> {
    const paymentHistory = await this.getCustomerPaymentHistory(customerId);
    const subscriptionHistory = await this.getCustomerSubscriptionHistory(customerId);
    const engagementMetrics = await this.getCustomerEngagementMetrics(customerId);

    // Risk factors with enhanced scoring
    const factors = {
      paymentFailureRate: this.calculatePaymentFailureRisk(paymentHistory),
      subscriptionChurnRisk: this.calculateSubscriptionChurnRisk(subscriptionHistory),
      engagementRisk: this.calculateEngagementRisk(engagementMetrics),
      recencyRisk: this.calculateRecencyRisk(paymentHistory.lastPaymentDate),
      volatilityRisk: await this.calculateVolatilityRisk(customerId, paymentHistory.currency),
      customerLifetimeValueRisk: this.calculateCLVRisk(paymentHistory, subscriptionHistory),
    };

    // Dynamic weights based on data availability and customer profile
    const weights = this.calculateDynamicWeights(factors, paymentHistory, subscriptionHistory);

    // Apply risk multipliers for critical factors
    const adjustedFactors = this.applyRiskMultipliers(factors, paymentHistory, subscriptionHistory);

    const overallScore = Object.entries(adjustedFactors).reduce((total, [factor, score]) => {
      if (factor.startsWith('_')) return total; // Skip special properties
      const numericScore = typeof score === 'number' ? score : 0;
      const weight = weights[factor] || 0;
      return total + numericScore * weight;
    }, 0);

    const category = this.categorizeRiskScore(overallScore);

    // Calculate trends with more sophisticated analysis
    const trends = await this.calculateRiskTrends(customerId, overallScore);

    const riskScore = {
      overall: Math.round(overallScore),
      factors: adjustedFactors,
      category,
      lastCalculated: now(),
      trends,
    };

    // Validate and sanitize the risk calculation results
    return this.validateRiskCalculation(riskScore);
  }

  /**
   * Calculate dynamic weights based on data quality and customer profile
   */
  private calculateDynamicWeights(
    _factors: unknown,
    paymentHistory: StoredPaymentHistory,
    subscriptionHistory: StoredSubscriptionHistory,
  ): Record<string, number> {
    const baseWeights = {
      paymentFailureRate: 0.35,
      subscriptionChurnRisk: 0.25,
      engagementRisk: 0.15,
      recencyRisk: 0.1,
      volatilityRisk: 0.1,
      customerLifetimeValueRisk: 0.05,
    };

    // Adjust weights based on data availability
    const adjustments: Record<string, number> = {};

    // If customer has limited payment history, reduce payment-related weights
    if (paymentHistory.totalPayments < 5) {
      adjustments['paymentFailureRate'] = -0.1;
      adjustments['engagementRisk'] = 0.05;
      adjustments['recencyRisk'] = 0.05;
    }

    // If customer has limited subscription history, adjust subscription weights
    if (subscriptionHistory.totalSubscriptions < 2) {
      adjustments['subscriptionChurnRisk'] = -0.1;
      adjustments['engagementRisk'] = 0.05;
      adjustments['volatilityRisk'] = 0.05;
    }

    // Apply adjustments and normalize
    const adjustedWeights = Object.entries(baseWeights).reduce(
      (weights, [factor, weight]) => {
        weights[factor] = weight + (adjustments[factor] || 0);
        return weights;
      },
      {} as Record<string, number>,
    );

    // Normalize weights to sum to 1
    const totalWeight = Object.values(adjustedWeights).reduce((sum, weight) => sum + weight, 0);
    return Object.entries(adjustedWeights).reduce(
      (normalized, [factor, weight]) => {
        normalized[factor] = weight / totalWeight;
        return normalized;
      },
      {} as Record<string, number>,
    );
  }

  /**
   * Apply risk multipliers for critical scenarios
   */
  private applyRiskMultipliers(
    factors: Record<string, number>,
    paymentHistory: StoredPaymentHistory,
    subscriptionHistory: StoredSubscriptionHistory,
  ): Record<string, number> {
    const adjustedFactors = { ...factors };

    // Critical scenarios that increase risk significantly
    const criticalFactors = [];

    // Recent payment failures with increasing frequency
    if (paymentHistory.failedPayments > 2 && paymentHistory.totalPayments > 0) {
      const recentFailureRate = paymentHistory.failedPayments / paymentHistory.totalPayments;
      if (recentFailureRate > 0.5) {
        adjustedFactors['paymentFailureRate'] = (adjustedFactors['paymentFailureRate'] || 0) * 1.3; // 30% increase
        criticalFactors.push('high_payment_failure_rate');
      }
    }

    // Subscription churning behavior
    if (subscriptionHistory.canceledSubscriptions > 1 && subscriptionHistory.averageDuration < 2) {
      adjustedFactors['subscriptionChurnRisk'] = (adjustedFactors['subscriptionChurnRisk'] || 0) * 1.4; // 40% increase
      criticalFactors.push('subscription_churn_pattern');
    }

    // Very low engagement combined with payment issues
    if ((factors['engagementRisk'] || 0) > 70 && (factors['paymentFailureRate'] || 0) > 50) {
      adjustedFactors['engagementRisk'] = (adjustedFactors['engagementRisk'] || 0) * 1.2; // 20% increase
      adjustedFactors['paymentFailureRate'] = (adjustedFactors['paymentFailureRate'] || 0) * 1.1; // 10% increase
      criticalFactors.push('low_engagement_payment_issues');
    }

    // Log critical factors for reporting (don't store on the object as it breaks typing)
    if (criticalFactors.length > 0) {
      logger.debug('Critical risk factors identified', { criticalFactors });
    }

    return adjustedFactors;
  }

  /**
   * Calculate volatility risk based on payment amount and frequency patterns
   */
  private async calculateVolatilityRisk(customerId: CustomerId, currency: string | undefined): Promise<number> {
    // Amounts in different currencies cannot be compared, so only the customer's main currency counts
    if (!currency) {
      return 25; // No payments: moderate risk for insufficient data
    }

    // Get last 12 months of payment data for volatility analysis
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    const monthlyPayments = await this.db
      .select({
        month: sql<string>`DATE_TRUNC('month', created_at)`,
        paymentCount: sql<number>`COUNT(*)`.mapWith(Number),
        totalAmount: sql<number>`SUM(${this.payments.amountMinor})`.mapWith(Number),
        failureCount: sql<number>`COUNT(CASE WHEN status = 'failed' THEN 1 END)`.mapWith(Number),
      })
      .from(this.payments)
      .where(
        and(
          sql`${this.payments.customerId} = ${customerId}`,
          eq(this.payments.currency, currency),
          sql`${this.payments.createdAt} >= ${twelveMonthsAgo}`,
        ),
      )
      .groupBy(sql`DATE_TRUNC('month', created_at)`)
      .orderBy(sql`DATE_TRUNC('month', created_at)`);

    if (monthlyPayments.length < 3) {
      return 25; // Moderate risk for insufficient data
    }

    // Calculate coefficient of variation for payment amounts and frequencies
    const amounts = monthlyPayments.map(p => Number(p.totalAmount) || 0);
    const counts = monthlyPayments.map(p => Number(p.paymentCount) || 0);

    const amountVolatility = this.calculateCoefficientOfVariation(amounts);
    const frequencyVolatility = this.calculateCoefficientOfVariation(counts);

    // Higher volatility = higher risk
    const volatilityScore = Math.min(100, (amountVolatility + frequencyVolatility) * 50);

    return volatilityScore;
  }

  /**
   * Calculate Customer Lifetime Value risk
   */
  private calculateCLVRisk(paymentHistory: StoredPaymentHistory, subscriptionHistory: StoredSubscriptionHistory): number {
    if (paymentHistory.totalPayments === 0) return 50; // Unknown risk

    const avgMonthlyRevenue = paymentHistory.averageAmount || 0;
    const avgSubscriptionDuration = subscriptionHistory.averageDuration || 1;

    const estimatedCLV = avgMonthlyRevenue * avgSubscriptionDuration;

    // Categorize CLV and assign risk scores
    if (estimatedCLV > 1000) return 10; // High value customer, low risk
    if (estimatedCLV > 500) return 25; // Medium value customer
    if (estimatedCLV > 100) return 50; // Low-medium value customer
    return 80; // Very low value customer, high risk
  }

  /**
   * Calculate trends with historical analysis
   */
  private async calculateRiskTrends(customerId: CustomerId, _currentScore: number): Promise<RiskScore['trends']> {
    // Get historical risk scores if available (would typically be stored)
    // For now, calculate trend based on recent payment and subscription behavior

    // Raw `sql` parameters bypass the column codec, so these working values stay `Date`s.
    const current = new Date();
    const thirtyDaysAgo = new Date(current.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(current.getTime() - 60 * 24 * 60 * 60 * 1000);

    // Compare recent vs older payment patterns
    const recentPayments = await this.db
      .select({
        totalPayments: sql<number>`COUNT(*)`.mapWith(Number),
        failedPayments: sql<number>`COUNT(CASE WHEN status = 'failed' THEN 1 END)`.mapWith(Number),
      })
      .from(this.payments)
      .where(
        and(sql`${this.payments.customerId} = ${customerId}`, sql`${this.payments.createdAt} >= ${thirtyDaysAgo}`),
      );

    const olderPayments = await this.db
      .select({
        totalPayments: sql<number>`COUNT(*)`.mapWith(Number),
        failedPayments: sql<number>`COUNT(CASE WHEN status = 'failed' THEN 1 END)`.mapWith(Number),
      })
      .from(this.payments)
      .where(
        and(
          sql`${this.payments.customerId} = ${customerId}`,
          sql`${this.payments.createdAt} >= ${sixtyDaysAgo}`,
          sql`${this.payments.createdAt} < ${thirtyDaysAgo}`,
        ),
      );

    const recentData = recentPayments[0] || { totalPayments: 0, failedPayments: 0 };
    const olderData = olderPayments[0] || { totalPayments: 0, failedPayments: 0 };

    // Calculate trend direction
    let direction: 'improving' | 'declining' | 'stable' = 'stable';
    let changePercent = 0;

    if (recentData.totalPayments > 0 && olderData.totalPayments > 0) {
      const recentFailureRate = recentData.failedPayments / recentData.totalPayments;
      const olderFailureRate = olderData.failedPayments / olderData.totalPayments;

      const failureRateChange = recentFailureRate - olderFailureRate;
      changePercent = Math.round(failureRateChange * 100);

      if (failureRateChange < -0.1) {
        direction = 'improving';
      } else if (failureRateChange > 0.1) {
        direction = 'declining';
      }
    }

    // The trend is about failure rate: amounts in different currencies cannot be compared, so no volume trend
    return { direction, changePercent: Math.abs(changePercent), timeframe: 30 };
  }

  /**
   * Calculate coefficient of variation for volatility analysis
   */
  private calculateCoefficientOfVariation(values: number[]): number {
    if (values.length === 0) return 0;

    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    if (mean === 0) return 0;

    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const standardDeviation = Math.sqrt(variance);

    return standardDeviation / mean;
  }

  /**
   * Calculate payment failure risk (0-100)
   */
  private calculatePaymentFailureRisk(paymentHistory: StoredPaymentHistory): number {
    if (paymentHistory.totalPayments === 0) return 50; // Unknown risk

    const failureRate = paymentHistory.failedPayments / paymentHistory.totalPayments;
    return Math.min(100, failureRate * 100 * 2); // Scale up for sensitivity
  }

  /**
   * Calculate subscription churn risk (0-100)
   */
  private calculateSubscriptionChurnRisk(subscriptionHistory: StoredSubscriptionHistory): number {
    if (subscriptionHistory.totalSubscriptions === 0) return 0;

    const churnRate = subscriptionHistory.canceledSubscriptions / subscriptionHistory.totalSubscriptions;
    const avgDurationRisk = subscriptionHistory.averageDuration < 3 ? 30 : 0; // Short duration = higher risk

    return Math.min(100, churnRate * 100 + avgDurationRisk);
  }

  /**
   * Calculate engagement risk (0-100)
   */
  private calculateEngagementRisk(engagementMetrics: StoredEngagementMetrics): number {
    const scoreRisk = (100 - engagementMetrics.score) * 0.8; // Invert engagement score

    const recencyRisk = engagementMetrics.lastActivity
      ? Math.min(
          50,
          Math.max(0, (Date.now() - toMillis(engagementMetrics.lastActivity)) / (1000 * 60 * 60 * 24) - 7) * 2,
        )
      : 50;

    return Math.min(100, scoreRisk + recencyRisk);
  }

  /**
   * Calculate recency risk based on last payment (0-100)
   */
  private calculateRecencyRisk(lastPaymentDate?: Instant): number {
    if (!lastPaymentDate) return 100; // No payments = highest risk

    const daysSinceLastPayment = (Date.now() - toMillis(lastPaymentDate)) / (1000 * 60 * 60 * 24);
    return Math.min(100, Math.max(0, (daysSinceLastPayment - 30) * 2)); // Risk increases after 30 days
  }

  /**
   * Categorize risk score into levels
   */
  private categorizeRiskScore(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score < 25) return 'low';
    if (score < 50) return 'medium';
    if (score < 75) return 'high';
    return 'critical';
  }

  /**
   * Get customer payment history for risk calculation
   */
  private async getCustomerPaymentHistory(customerId: CustomerId): Promise<StoredPaymentHistory> {
    // One row per currency: an average over minor units of different currencies means nothing
    const rows = await this.db
      .select({
        currency: this.payments.currency,
        totalPayments: sql<number>`COUNT(*)`.mapWith(Number),
        successfulPayments: sql<number>`COUNT(CASE WHEN status = 'succeeded' THEN 1 END)`.mapWith(Number),
        failedPayments: sql<number>`COUNT(CASE WHEN status = 'failed' THEN 1 END)`.mapWith(Number),
        averageAmount: sql<number>`AVG(${this.payments.amountMinor})`.mapWith(Number),
        lastPaymentDate: sql`MAX(CASE WHEN status = 'succeeded' THEN created_at END)`.mapWith(this.payments.createdAt),
        lastFailureDate: sql`MAX(CASE WHEN status = 'failed' THEN created_at END)`.mapWith(this.payments.createdAt),
        firstPaymentDate: sql`MIN(created_at)`.mapWith(this.payments.createdAt),
      })
      .from(this.payments)
      .where(sql`${this.payments.customerId} = ${customerId}`)
      .groupBy(this.payments.currency);

    // Counts add up across currencies. The average is reported for the currency with the most payments
    // (ties go to the first code alphabetically), and `currency` says which one it is.
    const main = rows.toSorted((a, b) => b.totalPayments - a.totalPayments || a.currency.localeCompare(b.currency))[0];
    const latest = (dates: (Instant | null)[]) =>
      dates.filter((date): date is Instant => date !== null).toSorted((a, b) => toMillis(b) - toMillis(a))[0];
    const earliest = rows
      .map(row => row.firstPaymentDate)
      .filter((date): date is Instant => date !== null)
      .toSorted((a, b) => toMillis(a) - toMillis(b))[0];
    const lastFailure = latest(rows.map(row => row.lastFailureDate));
    const streakStart = lastFailure ?? earliest;

    return {
      totalPayments: rows.reduce((sum, row) => sum + row.totalPayments, 0),
      successfulPayments: rows.reduce((sum, row) => sum + row.successfulPayments, 0),
      failedPayments: rows.reduce((sum, row) => sum + row.failedPayments, 0),
      averageAmount: main?.averageAmount ?? 0,
      currency: main?.currency,
      lastPaymentDate: latest(rows.map(row => row.lastPaymentDate)),
      // Days without a failed payment: since the last failure, or since the first payment when none failed
      streakDays: streakStart ? Math.floor((Date.now() - toMillis(streakStart)) / 86_400_000) : 0,
    };
  }

  /**
   * Get customer subscription history for risk calculation
   */
  private async getCustomerSubscriptionHistory(customerId: CustomerId): Promise<StoredSubscriptionHistory> {
    const result = await this.db
      .select({
        totalSubscriptions: sql<number>`COUNT(*)`.mapWith(Number),
        activeSubscriptions: sql<number>`COUNT(CASE WHEN status = 'active' THEN 1 END)`.mapWith(Number),
        canceledSubscriptions: sql<number>`COUNT(CASE WHEN status = 'canceled' THEN 1 END)`.mapWith(Number),
        averageDuration: sql<number>`AVG(EXTRACT(EPOCH FROM (COALESCE(canceled_at, NOW()) - created_at)) / 86400 / 30)`.mapWith(Number),
        currentStatus: sql<string>`MAX(CASE WHEN status = 'active' THEN status END)`,
      })
      .from(this.subscriptions)
      .where(sql`${this.subscriptions.customerId} = ${customerId}`);

    const row = result[0];

    return {
      totalSubscriptions: row?.totalSubscriptions ?? 0,
      activeSubscriptions: row?.activeSubscriptions ?? 0,
      canceledSubscriptions: row?.canceledSubscriptions ?? 0,
      averageDuration: row?.averageDuration ?? 0,
      currentStatus: row?.currentStatus ?? undefined,
    };
  }

  /**
   * Get customer engagement metrics for risk calculation
   */
  private async getCustomerEngagementMetrics(customerId: CustomerId): Promise<StoredEngagementMetrics> {
    // Get customer information for engagement calculation
    const [customer] = await this.db
      .select({ id: this.customers.id })
      .from(this.customers)
      .where(eq(this.customers.id, customerId))
      .limit(1);

    if (!customer) {
      return {
        score: 0,
        lastActivity: undefined,
        activityFrequency: 0,
        featureUsage: {},
      };
    }

    // Calculate engagement based on available data
    const current = new Date();
    const thirtyDaysAgo = new Date(current.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Get recent payment activity as a proxy for engagement
    const recentPaymentActivity = await this.db
      .select({
        paymentCount: sql<number>`COUNT(*)`.mapWith(Number),
        lastPaymentDate: sql`MAX(created_at)`.mapWith(this.payments.createdAt),
        // NULLIF: a customer with no payment in the window has COUNT(*) = 0, which Postgres refuses to divide by
        successRate: sql<number>`COALESCE(ROUND((COUNT(CASE WHEN status = 'succeeded' THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0)), 2), 0)`.mapWith(Number),
      })
      .from(this.payments)
      .where(
        and(sql`${this.payments.customerId} = ${customerId}`, sql`${this.payments.createdAt} >= ${thirtyDaysAgo}`),
      );

    const paymentActivity = recentPaymentActivity[0] || {
      paymentCount: 0,
      lastPaymentDate: null,
      successRate: 0,
    };

    // Get subscription engagement (active subscriptions, upgrades, etc.)
    const subscriptionEngagement = await this.db
      .select({
        activeSubscriptions: sql<number>`COUNT(CASE WHEN status = 'active' THEN 1 END)`.mapWith(Number),
        recentStatusChanges: sql<number>`COUNT(CASE WHEN updated_at >= ${thirtyDaysAgo} THEN 1 END)`.mapWith(Number),
        lastSubscriptionUpdate: sql`MAX(updated_at)`.mapWith(this.subscriptions.updatedAt),
      })
      .from(this.subscriptions)
      .where(sql`${this.subscriptions.customerId} = ${customerId}`);

    const subEngagement = subscriptionEngagement[0] || {
      activeSubscriptions: 0,
      recentStatusChanges: 0,
      lastSubscriptionUpdate: null,
    };

    // Calculate composite engagement score (0-100)
    let engagementScore = 0;

    // Payment activity contributes 40% to engagement score
    if (paymentActivity.paymentCount > 0) {
      const paymentFrequencyScore = Math.min(40, paymentActivity.paymentCount * 10); // Up to 40 points for frequent payments
      const successRateBonus = (paymentActivity.successRate / 100) * 10; // Up to 10 bonus points for high success rate
      engagementScore += paymentFrequencyScore + successRateBonus;
    }

    // Subscription activity contributes 30% to engagement score
    const activeSubBonus = subEngagement.activeSubscriptions * 15; // 15 points per active subscription
    const recentActivityBonus = subEngagement.recentStatusChanges * 5; // 5 points per recent subscription change
    engagementScore += Math.min(30, activeSubBonus + recentActivityBonus);

    // Recency contributes 30% to engagement score
    const mostRecentActivity = [paymentActivity.lastPaymentDate, subEngagement.lastSubscriptionUpdate]
      .filter((date): date is Instant => date !== null)
      .toSorted((a, b) => toMillis(b) - toMillis(a))[0];

    if (mostRecentActivity) {
      const daysSinceLastActivity = (current.getTime() - toMillis(mostRecentActivity)) / (1000 * 60 * 60 * 24);
      let recencyScore = Math.max(0, 30 - daysSinceLastActivity); // Decreases by 1 point per day
      recencyScore = Math.max(0, recencyScore);
      engagementScore += recencyScore;
    }

    // Calculate activity frequency (activities per week over last 30 days)
    const totalActivities = paymentActivity.paymentCount + subEngagement.recentStatusChanges;
    const activityFrequency = (totalActivities / 30) * 7; // Convert to weekly frequency

    return {
      score: Math.min(100, Math.round(engagementScore)),
      lastActivity: mostRecentActivity,
      activityFrequency: Number(activityFrequency.toFixed(2)),
      featureUsage: {
        payments: paymentActivity.paymentCount,
        subscriptionChanges: subEngagement.recentStatusChanges,
        activeSubscriptions: subEngagement.activeSubscriptions,
        paymentSuccessRate: paymentActivity.successRate,
      },
    };
  }

  /**
   * Update or create customer risk profile
   */
  async updateCustomerRiskProfile(customerId: CustomerId): Promise<CustomerRiskProfile | MoneyFailure> {
    const riskScore = await this.calculateCustomerRiskScore(customerId);
    const paymentHistory = await this.getCustomerPaymentHistory(customerId);
    const subscriptionHistory = await this.getCustomerSubscriptionHistory(customerId);
    const engagementMetrics = await this.getCustomerEngagementMetrics(customerId);

    // Get customer segments
    const segmentIds = await this.getCustomerSegments(customerId);
    if (isFailure(segmentIds)) return segmentIds;

    // Get or create communication preferences
    const communicationPreferences = {
      preferredChannel: 'email' as const,
      unsubscribed: false,
      unsubscribedChannels: [],
      timezone: 'UTC',
      language: 'en',
    };

    // The repository expects the domain model structure
    const profileData = {
      customerId,
      segmentIds,
      riskScore,
      paymentHistory,
      subscriptionHistory,
      engagementMetrics,
      communicationPreferences,
      metadata: null,
    };

    const dbProfile = await this.riskProfileRepo.upsert(profileData);
    invariant(dbProfile, () => `the risk profile upsert for customer ${customerId} returned no row`);
    return dbProfile;
  }

  /**
   * Get segments that a customer belongs to
   */
  async getCustomerSegments(customerId: CustomerId): Promise<CustomerSegmentId[] | MoneyFailure> {
    const [customer] = await this.db
      .select({ id: this.customers.id })
      .from(this.customers)
      .where(eq(this.customers.id, customerId))
      .limit(1);

    if (!customer) return [];

    const dbSegments = await this.segmentRepo.findMany({
      limit: 100,
      offset: 0,
      isActive: true,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    const segments = dbSegments;

    const matchingSegments: CustomerSegmentId[] = [];

    for (const segment of segments) {
      const conditions = this.buildSegmentConditions(segment.criteria);
      if (isFailure(conditions)) return conditions;
      // The criteria narrowed to this one customer: a match is this customer, never another one listed first
      const [match] = await this.db
        .select({ id: this.customers.id })
        .from(this.customers)
        .where(and(eq(this.customers.id, customerId), ...conditions))
        .limit(1);
      if (match) {
        matchingSegments.push(segment.id);
      }
    }

    return matchingSegments;
  }

  /**
   * Validate and sanitize risk calculation results
   */
  private validateRiskCalculation(riskScore: RiskScore): RiskScore {
    // Ensure all factor scores are within valid range (0-100)
    const sanitizedFactors = Object.entries(riskScore.factors).reduce<Record<string, number>>(
      (factors, [key, value]) => {
        const numValue = typeof value === 'number' ? value : 0;
        factors[key] = Math.min(100, Math.max(0, numValue));
        return factors;
      },
      {},
    );

    // Ensure overall score is valid
    const sanitizedOverall = Math.min(100, Math.max(0, riskScore.overall || 0));

    // Validate category matches the score
    const validatedCategory = this.categorizeRiskScore(sanitizedOverall);

    return {
      ...riskScore,
      overall: sanitizedOverall,
      factors: sanitizedFactors,
      category: validatedCategory,
    };
  }

  /**
   * Recalculate the risk profile of up to `limit` customers. Returns how many were tried and each
   * customer whose profile was not updated (a stored range money refuses, or a thrown error).
   */
  async bulkUpdateRiskProfiles(limit = 100): Promise<DunningTickReport> {
    const customerIds = await this.db.select({ id: this.customers.id }).from(this.customers).limit(limit);
    const report: DunningTickReport = { processed: customerIds.length, failed: [] };

    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[],
    };

    logger.info('Starting bulk risk profile update', {
      customerCount: customerIds.length,
      limit,
    });

    for (const { id } of customerIds) {
      try {
        const updated = await this.updateCustomerRiskProfile(id);
        if (isFailure(updated)) {
          // A stored segment with a spend range that is not valid money: counted as failed, never as updated
          results.failed++;
          results.errors.push(`Customer ${id}: ${updated.code}`);
          report.failed.push(tickFault(id, updated));
          logger.error('Failed to update risk profile', { customerId: id, error: updated.code });
          continue;
        }
        results.success++;

        // Log progress for large batches
        if (results.success % 10 === 0) {
          logger.info('Bulk update progress', {
            processed: results.success,
            total: customerIds.length,
            percentComplete: Math.round((results.success / customerIds.length) * 100),
          });
        }
      } catch (error) {
        results.failed++;
        const errorMessage = `Customer ${id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        results.errors.push(errorMessage);
        report.failed.push(tickFault(id, error));
        logger.error('Failed to update risk profile', {
          customerId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('Bulk update completed', {
      successful: results.success,
      failed: results.failed,
      totalProcessed: customerIds.length,
    });

    if (results.errors.length > 0) {
      logger.warn('Bulk update had errors', {
        errorCount: results.errors.length,
        firstFiveErrors: results.errors.slice(0, 5),
      });
    }
    return report;
  }

  /** Recount the auto-update segments. Returns how many were tried and each segment that was not counted. */
  async processAutoUpdateSegments(): Promise<DunningTickReport> {
    const segments = await this.segmentRepo.findSegmentsForAutoUpdate();
    const report: DunningTickReport = { processed: segments.length, failed: [] };

    for (const segment of segments) {
      try {
        const counted = await this.updateSegmentCustomerCount(segment.id);
        if (isFailure(counted)) {
          logger.error('Segment {segmentId} could not be counted: {code}', {
            segmentId: segment.id,
            code: counted.code,
          });
          report.failed.push(tickFault(segment.id, counted));
        }
      } catch (error) {
        logger.error('Failed to update segment', {
          segmentId: segment.id,
          error: error instanceof Error ? error.message : String(error),
        });
        report.failed.push(tickFault(segment.id, error));
      }
    }
    return report;
  }

  /**
   * Get risk profile for a customer
   */
  async getCustomerRiskProfile(customerId: CustomerId): Promise<CustomerRiskProfile | null> {
    const dbProfile = await this.riskProfileRepo.findByCustomerId(customerId);
    return dbProfile ?? null;
  }

  /**
   * Get customers by risk category
   */
  async getCustomersByRiskCategory(category: string, limit = 100): Promise<CustomerRiskProfile[]> {
    const dbProfiles = await this.riskProfileRepo.findByRiskCategory(category, limit);
    return dbProfiles;
  }
}

/**
 * Factory function to create CustomerSegmentationService
 */
export function createCustomerSegmentationService(
  db: DunningDatabase,
  coreTables: SegmentationCoreTables,
  dunningTables: SegmentationDunningTables,
) {
  return new CustomerSegmentationService(db, coreTables, dunningTables);
}
