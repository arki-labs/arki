import { and, eq, sql } from 'drizzle-orm';

import type { Instant } from '@arki/date';
import { now, toMillis } from '@arki/date';
import { getLogger } from '@arki/log';
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
  EngagementMetrics,
  PaymentHistoryData,
  RiskScore,
  SegmentCriteria,
  SubscriptionHistoryData,
} from '../types.js';
import { toMinorColumn } from '../../core/money.js';
import { createCustomerRiskProfileRepository, createCustomerSegmentRepository } from '../repository.js';

const logger = getLogger('dunning.segmentation');

// Utility functions removed in favor of Drizzle types

/**
 * Service for customer segmentation and risk scoring
 * Handles segment management, customer classification, and risk assessment
 */
export type SegmentationCoreTables = Pick<CoreTables, 'customers' | 'payments' | 'subscriptions'>;
export type SegmentationDunningTables = Pick<DunningTables, 'customerSegments' | 'customerRiskProfiles'>;

export class CustomerSegmentationService {
  private segmentRepo;
  private riskProfileRepo;
  private readonly customers: CoreTables['customers'];
  private readonly payments: CoreTables['payments'];
  private readonly subscriptions: CoreTables['subscriptions'];

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
  }

  /**
   * Create a new customer segment
   */
  async createSegment(input: CreateCustomerSegmentInput, createdBy: string): Promise<CustomerSegment> {
    const dbSegment = await this.segmentRepo.create({
      ...input,
      createdBy,
    });

    if (!dbSegment) {
      throw new Error('Failed to create segment');
    }

    const segment = dbSegment;

    // Calculate initial customer count if auto-update is enabled
    if (input.autoUpdate) {
      await this.updateSegmentCustomerCount(segment.id);
    }

    return segment;
  }

  /**
   * Update an existing segment
   */
  async updateSegment(
    segmentId: CustomerSegmentId,
    input: UpdateCustomerSegmentInput,
  ): Promise<CustomerSegment | null> {
    const dbSegment = await this.segmentRepo.update(segmentId, input);

    if (!dbSegment) {
      return null;
    }

    const segment = dbSegment;

    // Recalculate customer count if criteria changed
    if (input.criteria) {
      await this.updateSegmentCustomerCount(segment.id);
    }

    return segment;
  }

  /**
   * Get segment by ID
   */
  async getSegment(segmentId: CustomerSegmentId): Promise<CustomerSegment | null> {
    const dbSegment = await this.segmentRepo.findById(segmentId);
    return dbSegment ? dbSegment : null;
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
   * Calculate and update customer count for a segment
   */
  async updateSegmentCustomerCount(segmentId: CustomerSegmentId): Promise<void> {
    const dbSegment = await this.segmentRepo.findById(segmentId);
    if (!dbSegment) {
      throw new Error(`Segment ${segmentId} not found`);
    }

    const segment = dbSegment;
    const customerCount = await this.calculateSegmentCustomerCount(segment.criteria);
    await this.segmentRepo.updateCustomerCount(segmentId, customerCount);
  }

  /**
   * Calculate customer count for segment criteria
   */
  private async calculateSegmentCustomerCount(criteria: SegmentCriteria): Promise<number> {
    const conditions = this.buildSegmentConditions(criteria);

    const result =
      conditions.length > 0
        ? await this.db
            .select({ count: sql<number>`COUNT(DISTINCT ${this.customers.id})` })
            .from(this.customers)
            .where(conditions.length === 1 ? conditions[0] : and(...conditions))
        : await this.db.select({ count: sql<number>`COUNT(DISTINCT ${this.customers.id})` }).from(this.customers);

    return result[0]?.count ?? 0;
  }

  /**
   * Get customers matching segment criteria
   */
  async getCustomersInSegment(segmentId: CustomerSegmentId, limit = 100): Promise<any[]> {
    const dbSegment = await this.segmentRepo.findById(segmentId);
    if (!dbSegment) {
      throw new Error(`Segment ${segmentId} not found`);
    }

    const segment = dbSegment;
    return this.getCustomersMatchingCriteria(segment.criteria, limit);
  }

  /**
   * Get customers matching specific criteria
   */
  async getCustomersMatchingCriteria(criteria: SegmentCriteria, limit = 100): Promise<any[]> {
    const conditions = this.buildSegmentConditions(criteria);

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
   * Build SQL conditions from segment criteria
   */
  private buildSegmentConditions(criteria: SegmentCriteria): any[] {
    const conditions = [];

    // Total spent criteria: only payments in the range's currency count, compared in minor units
    // (summing USD and EUR into one number would be meaningless).
    const spendBound = criteria.totalSpent?.min ?? criteria.totalSpent?.max;
    if (criteria.totalSpent && spendBound) {
      const { min, max } = criteria.totalSpent;
      const totalSpentSubquery = this.db
        .select({ customerId: this.payments.customerId, total: sql<string>`SUM(${this.payments.amountMinor})` })
        .from(this.payments)
        .where(
          and(
            eq(this.payments.status, 'succeeded'),
            eq(this.payments.currency, Money.fromJSON(spendBound).currency.code),
          ),
        )
        .groupBy(this.payments.customerId);

      if (min !== undefined) {
        conditions.push(
          sql`
            ${this.customers.id} IN (
                        SELECT customer_id FROM (${totalSpentSubquery}) AS totals
                        WHERE total >= ${toMinorColumn(Money.fromJSON(min))}
                      )
          `,
        );
      }

      if (max !== undefined) {
        conditions.push(
          sql`
            ${this.customers.id} IN (
                        SELECT customer_id FROM (${totalSpentSubquery}) AS totals
                        WHERE total <= ${toMinorColumn(Money.fromJSON(max))}
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
                    JOIN plans p ON s.plan_id = p.id
                    WHERE p.tier = ANY(${criteria.planTier})
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
      volatilityRisk: await this.calculateVolatilityRisk(customerId),
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
    paymentHistory: PaymentHistoryData,
    subscriptionHistory: SubscriptionHistoryData,
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
    paymentHistory: PaymentHistoryData,
    subscriptionHistory: SubscriptionHistoryData,
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
  private async calculateVolatilityRisk(customerId: CustomerId): Promise<number> {
    // Get last 12 months of payment data for volatility analysis
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    const monthlyPayments = await this.db
      .select({
        month: sql<string>`DATE_TRUNC('month', created_at)`,
        paymentCount: sql<number>`COUNT(*)`,
        totalAmount: sql<number>`SUM(amount)`,
        avgAmount: sql<number>`AVG(amount)`,
        failureCount: sql<number>`COUNT(CASE WHEN status = 'failed' THEN 1 END)`,
      })
      .from(this.payments)
      .where(
        and(sql`${this.payments.customerId} = ${customerId}`, sql`${this.payments.createdAt} >= ${twelveMonthsAgo}`),
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
  private calculateCLVRisk(paymentHistory: PaymentHistoryData, subscriptionHistory: SubscriptionHistoryData): number {
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
  private async calculateRiskTrends(customerId: CustomerId, _currentScore: number): Promise<any> {
    // Get historical risk scores if available (would typically be stored)
    // For now, calculate trend based on recent payment and subscription behavior

    // Raw `sql` parameters bypass the column codec, so these working values stay `Date`s.
    const current = new Date();
    const thirtyDaysAgo = new Date(current.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(current.getTime() - 60 * 24 * 60 * 60 * 1000);

    // Compare recent vs older payment patterns
    const recentPayments = await this.db
      .select({
        totalPayments: sql<number>`COUNT(*)`,
        failedPayments: sql<number>`COUNT(CASE WHEN status = 'failed' THEN 1 END)`,
        avgAmount: sql<number>`AVG(amount)`,
      })
      .from(this.payments)
      .where(
        and(sql`${this.payments.customerId} = ${customerId}`, sql`${this.payments.createdAt} >= ${thirtyDaysAgo}`),
      );

    const olderPayments = await this.db
      .select({
        totalPayments: sql<number>`COUNT(*)`,
        failedPayments: sql<number>`COUNT(CASE WHEN status = 'failed' THEN 1 END)`,
        avgAmount: sql<number>`AVG(amount)`,
      })
      .from(this.payments)
      .where(
        and(
          sql`${this.payments.customerId} = ${customerId}`,
          sql`${this.payments.createdAt} >= ${sixtyDaysAgo}`,
          sql`${this.payments.createdAt} < ${thirtyDaysAgo}`,
        ),
      );

    const recentData = recentPayments[0] || { totalPayments: 0, failedPayments: 0, avgAmount: 0 };
    const olderData = olderPayments[0] || { totalPayments: 0, failedPayments: 0, avgAmount: 0 };

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

    return {
      direction,
      changePercent: Math.abs(changePercent),
      timeframe: 30,
      factors: {
        recentPaymentActivity: recentData.totalPayments,
        recentFailureRate:
          recentData.totalPayments > 0 ? Math.round((recentData.failedPayments / recentData.totalPayments) * 100) : 0,
        paymentVolumeChange:
          olderData.avgAmount > 0
            ? Math.round(((recentData.avgAmount - olderData.avgAmount) / olderData.avgAmount) * 100)
            : 0,
      },
    };
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
  private calculatePaymentFailureRisk(paymentHistory: PaymentHistoryData): number {
    if (paymentHistory.totalPayments === 0) return 50; // Unknown risk

    const failureRate = paymentHistory.failedPayments / paymentHistory.totalPayments;
    return Math.min(100, failureRate * 100 * 2); // Scale up for sensitivity
  }

  /**
   * Calculate subscription churn risk (0-100)
   */
  private calculateSubscriptionChurnRisk(subscriptionHistory: SubscriptionHistoryData): number {
    if (subscriptionHistory.totalSubscriptions === 0) return 0;

    const churnRate = subscriptionHistory.canceledSubscriptions / subscriptionHistory.totalSubscriptions;
    const avgDurationRisk = subscriptionHistory.averageDuration < 3 ? 30 : 0; // Short duration = higher risk

    return Math.min(100, churnRate * 100 + avgDurationRisk);
  }

  /**
   * Calculate engagement risk (0-100)
   */
  private calculateEngagementRisk(engagementMetrics: EngagementMetrics): number {
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
  private async getCustomerPaymentHistory(customerId: CustomerId): Promise<any> {
    const result = await this.db
      .select({
        totalPayments: sql<number>`COUNT(*)`,
        successfulPayments: sql<number>`COUNT(CASE WHEN status = 'succeeded' THEN 1 END)`,
        failedPayments: sql<number>`COUNT(CASE WHEN status = 'failed' THEN 1 END)`,
        averageAmount: sql<number>`AVG(amount)`,
        lastPaymentDate: sql`MAX(CASE WHEN status = 'succeeded' THEN created_at END)`.mapWith(this.payments.createdAt),
      })
      .from(this.payments)
      .where(sql`${this.payments.customerId} = ${customerId}`);

    return (
      result[0] ?? {
        totalPayments: 0,
        successfulPayments: 0,
        failedPayments: 0,
        averageAmount: 0,
        lastPaymentDate: null,
      }
    );
  }

  /**
   * Get customer subscription history for risk calculation
   */
  private async getCustomerSubscriptionHistory(customerId: CustomerId): Promise<any> {
    const result = await this.db
      .select({
        totalSubscriptions: sql<number>`COUNT(*)`,
        activeSubscriptions: sql<number>`COUNT(CASE WHEN status = 'active' THEN 1 END)`,
        canceledSubscriptions: sql<number>`COUNT(CASE WHEN status = 'canceled' THEN 1 END)`,
        averageDuration: sql<number>`AVG(EXTRACT(EPOCH FROM (COALESCE(canceled_at, NOW()) - created_at)) / 86400 / 30)`,
        currentStatus: sql<string>`MAX(CASE WHEN status = 'active' THEN status END)`,
      })
      .from(this.subscriptions)
      .where(sql`${this.subscriptions.customerId} = ${customerId}`);

    return (
      result[0] ?? {
        totalSubscriptions: 0,
        activeSubscriptions: 0,
        canceledSubscriptions: 0,
        averageDuration: 0,
        currentStatus: null,
      }
    );
  }

  /**
   * Get customer engagement metrics for risk calculation
   */
  private async getCustomerEngagementMetrics(customerId: CustomerId): Promise<any> {
    // Get customer information for engagement calculation
    const customerQuery = this.db.query as unknown as {
      customers: { findFirst: (config: { where: { id: CustomerId } }) => Promise<Customer | undefined> };
    };
    const customer = await customerQuery.customers.findFirst({
      where: { id: customerId },
    });

    if (!customer) {
      return {
        score: 0,
        lastActivity: null,
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
        paymentCount: sql<number>`COUNT(*)`,
        lastPaymentDate: sql`MAX(created_at)`.mapWith(this.payments.createdAt),
        successRate: sql<number>`ROUND((COUNT(CASE WHEN status = 'succeeded' THEN 1 END) * 100.0 / COUNT(*)), 2)`,
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
        activeSubscriptions: sql<number>`COUNT(CASE WHEN status = 'active' THEN 1 END)`,
        recentStatusChanges: sql<number>`COUNT(CASE WHEN updated_at >= ${thirtyDaysAgo} THEN 1 END)`,
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
      .sort((a, b) => toMillis(b) - toMillis(a))[0];

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
  async updateCustomerRiskProfile(customerId: CustomerId): Promise<CustomerRiskProfile> {
    const riskScore = await this.calculateCustomerRiskScore(customerId);
    const paymentHistory = await this.getCustomerPaymentHistory(customerId);
    const subscriptionHistory = await this.getCustomerSubscriptionHistory(customerId);
    const engagementMetrics = await this.getCustomerEngagementMetrics(customerId);

    // Get customer segments
    const segmentIds = await this.getCustomerSegments(customerId);

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
      segmentIds: segmentIds as CustomerSegmentId[],
      riskScore,
      paymentHistory,
      subscriptionHistory,
      engagementMetrics,
      communicationPreferences,
      metadata: null,
    };

    const dbProfile = await this.riskProfileRepo.upsert(profileData);
    if (!dbProfile) {
      throw new Error(`Failed to upsert risk profile for customer ${customerId}`);
    }
    return dbProfile;
  }

  /**
   * Get segments that a customer belongs to
   */
  async getCustomerSegments(customerId: CustomerId): Promise<string[]> {
    const customerQuery = this.db.query as unknown as {
      customers: { findFirst: (config: { where: { id: CustomerId } }) => Promise<Customer | undefined> };
    };
    const customer = await customerQuery.customers.findFirst({
      where: { id: customerId },
    });

    if (!customer) return [];

    const dbSegments = await this.segmentRepo.findMany({
      limit: 100,
      offset: 0,
      isActive: true,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });

    const segments = dbSegments;

    const matchingSegments = [];

    for (const segment of segments) {
      const matchingCustomers = await this.getCustomersMatchingCriteria(segment.criteria, 1);
      if (matchingCustomers.some(c => c.id === customerId)) {
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
   * Bulk update all customer risk profiles with enhanced error handling
   */
  async bulkUpdateRiskProfiles(limit = 100): Promise<void> {
    const customerIds = await this.db.select({ id: this.customers.id }).from(this.customers).limit(limit);

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
        await this.updateCustomerRiskProfile(id);
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
  }

  /**
   * Process auto-update segments
   */
  async processAutoUpdateSegments(): Promise<void> {
    const segments = await this.segmentRepo.findSegmentsForAutoUpdate();

    for (const segment of segments) {
      try {
        await this.updateSegmentCustomerCount(segment.id);
      } catch (error) {
        logger.error('Failed to update segment', {
          segmentId: segment.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Get risk profile for a customer
   */
  async getCustomerRiskProfile(customerId: CustomerId): Promise<CustomerRiskProfile | null> {
    const dbProfile = await this.riskProfileRepo.findByCustomerId(customerId);
    return dbProfile ? dbProfile : null;
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
