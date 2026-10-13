import type { Instant } from '@arki/date';
import type { KV } from '@arki/kv';
import type { Money } from '@arki/money';
import { now } from '@arki/date';

// AlertingService interface - to be implemented or imported from a shared location
type AlertingService = {
  sendCriticalAlert(alert: unknown): Promise<void>;
  sendWarningAlert(alert: unknown): Promise<void>;
}

type MetricValue = {
  value: number;
  timestamp: number;
  labels?: Record<string, string>;
}

type AlertThreshold = {
  warning: number;
  critical: number;
  window: number;
}

type PaymentResult = {
  success: boolean;
  status: string;
  processingTime: number;
  amount?: Money;
  provider?: string;
  errorCode?: string;
}

type PaymentAnomaly = {
  type: string;
  severity: 'warning' | 'critical';
  description: string;
  detectedAt: Instant;
  metadata?: Record<string, unknown>;
}

type PaymentAlert = {
  id: string;
  metricName: string;
  severity: 'warning' | 'critical';
  message: string;
  data: Record<string, unknown>;
  triggeredAt: Instant;
  status: 'active' | 'resolved';
}

type PaymentSystemHealth = {
  overall: number;
  payments: {
    successRate: number;
    avgProcessingTime: number;
    activeSubscriptions: number;
  };
  webhooks: {
    avgProcessingTime: number;
    successRate: number;
  };
  providers: Record<string, boolean>;
  lastUpdated: Instant;
}

export class PaymentMonitoringService {
  private metrics = new Map<string, MetricValue[]>();
  private alertThresholds = new Map<string, AlertThreshold>();
  private metricsCollectionInterval?: NodeJS.Timeout;

  constructor(
    private kv: KV,
    private alertingService?: AlertingService,
  ) {
    this.initializeThresholds();
    this.startMetricsCollection();
  }

  private initializeThresholds(): void {
    this.alertThresholds.set('payment_failure_rate', {
      warning: 0.05, // 5% failure rate
      critical: 0.1, // 10% failure rate
      window: 5 * 60 * 1000, // 5-minute window
    });

    this.alertThresholds.set('webhook_processing_time', {
      warning: 2000, // 2 seconds
      critical: 5000, // 5 seconds
      window: 60 * 1000, // 1-minute window
    });

    this.alertThresholds.set('subscription_churn_rate', {
      warning: 0.15, // 15% monthly churn
      critical: 0.25, // 25% monthly churn
      window: 24 * 60 * 60 * 1000, // Daily check
    });

    this.alertThresholds.set('refund_rate', {
      warning: 0.1, // 10% refund rate
      critical: 0.2, // 20% refund rate
      window: 24 * 60 * 60 * 1000, // Daily window
    });
  }

  private startMetricsCollection(): void {
    // Collect metrics every minute
    this.metricsCollectionInterval = setInterval(() => {
      this.cleanupOldMetrics();
    }, 60 * 1000);
  }

  async recordPaymentAttempt(result: PaymentResult): Promise<void> {
    // Record success/failure metrics
    await this.recordMetric('payment_attempts_total', 1, { status: result.status });
    await this.recordMetric('payment_processing_time', result.processingTime);

    if (!result.success) {
      await this.recordMetric('payment_failures_total', 1, {
        reason: result.errorCode ?? 'unknown',
        provider: result.provider ?? 'unknown',
      });

      // Check failure rate
      await this.checkFailureRate();
    }

    // Record revenue metrics
    // A metric is a float gauge per currency: the one place an amount is meant to become a number
    if (result.success && result.amount) {
      await this.recordMetric('revenue_processed', result.amount.toNumber(), {
        currency: result.amount.currency.code,
        provider: result.provider ?? 'unknown',
      });
    }
  }

  async recordWebhookProcessing(duration: number, success: boolean): Promise<void> {
    await this.recordMetric('webhook_processing_time', duration);
    await this.recordMetric('webhook_attempts_total', 1, {
      status: success ? 'success' : 'failure',
    });

    const threshold = this.alertThresholds.get('webhook_processing_time');
    if (threshold && duration > threshold.warning) {
      await this.checkWebhookPerformance();
    }
  }

  async recordSubscriptionEvent(event: 'created' | 'canceled' | 'upgraded' | 'downgraded'): Promise<void> {
    await this.recordMetric(`subscription_${event}_total`, 1);

    if (event === 'canceled') {
      await this.checkChurnRate();
    }
  }

  async recordRefund(amount: Money, reason: string): Promise<void> {
    await this.recordMetric('refunds_total', 1, { reason });
    await this.recordMetric('refund_amount_total', amount.toNumber(), { currency: amount.currency.code });
    await this.checkRefundRate();
  }

  private async recordMetric(
    name: string,
    value: number,
    labels?: Record<string, string>,
  ): Promise<void> {
    const metric: MetricValue = {
      value,
      timestamp: Date.now(),
      labels,
    };

    // Store in memory
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    this.metrics.get(name)!.push(metric);

    // Also store in KV for persistence
    const key = `metrics:${name}:${Date.now()}`;
    await this.kv.set(key, metric, 3600); // TTL 1 hour
  }

  private async getMetricValues(name: string, since: number): Promise<MetricValue[]> {
    const values = this.metrics.get(name) || [];
    return values.filter(v => v.timestamp >= since);
  }

  private async checkFailureRate(): Promise<void> {
    const window = 5 * 60 * 1000; // 5 minutes
    const nowMs = Date.now();
    const cutoff = nowMs - window;

    // Get recent payment attempts
    const attempts = await this.getMetricValues('payment_attempts_total', cutoff);
    const failures = await this.getMetricValues('payment_failures_total', cutoff);

    const totalAttempts = attempts.reduce((sum, m) => sum + m.value, 0);
    const totalFailures = failures.reduce((sum, m) => sum + m.value, 0);

    if (totalAttempts > 10) {
      // Minimum sample size
      const failureRate = totalFailures / totalAttempts;
      const threshold = this.alertThresholds.get('payment_failure_rate')!;

      if (failureRate >= threshold.critical) {
        await this.triggerAlert('payment_failure_rate', 'critical', {
          current: failureRate,
          threshold: threshold.critical,
          window: '5 minutes',
          totalAttempts,
          totalFailures,
        });
      } else if (failureRate >= threshold.warning) {
        await this.triggerAlert('payment_failure_rate', 'warning', {
          current: failureRate,
          threshold: threshold.warning,
          window: '5 minutes',
          totalAttempts,
          totalFailures,
        });
      }
    }
  }

  private async checkWebhookPerformance(): Promise<void> {
    const window = 60 * 1000; // 1 minute
    const cutoff = Date.now() - window;

    const processingTimes = await this.getMetricValues('webhook_processing_time', cutoff);
    if (processingTimes.length === 0) return;

    const avgTime = processingTimes.reduce((sum, m) => sum + m.value, 0) / processingTimes.length;
    const threshold = this.alertThresholds.get('webhook_processing_time')!;

    if (avgTime >= threshold.critical) {
      await this.triggerAlert('webhook_processing_time', 'critical', {
        avgTime,
        threshold: threshold.critical,
        sampleSize: processingTimes.length,
      });
    } else if (avgTime >= threshold.warning) {
      await this.triggerAlert('webhook_processing_time', 'warning', {
        avgTime,
        threshold: threshold.warning,
        sampleSize: processingTimes.length,
      });
    }
  }

  private async checkChurnRate(): Promise<void> {
    const window = 24 * 60 * 60 * 1000; // 24 hours
    const cutoff = Date.now() - window;

    const created = await this.getMetricValues('subscription_created_total', cutoff);
    const canceled = await this.getMetricValues('subscription_canceled_total', cutoff);

    const totalCreated = created.reduce((sum, m) => sum + m.value, 0);
    const totalCanceled = canceled.reduce((sum, m) => sum + m.value, 0);
    const netActive = totalCreated - totalCanceled;

    if (netActive > 0) {
      const churnRate = totalCanceled / netActive;
      const threshold = this.alertThresholds.get('subscription_churn_rate')!;

      if (churnRate >= threshold.critical) {
        await this.triggerAlert('subscription_churn_rate', 'critical', {
          churnRate,
          threshold: threshold.critical,
          totalCanceled,
          netActive,
        });
      } else if (churnRate >= threshold.warning) {
        await this.triggerAlert('subscription_churn_rate', 'warning', {
          churnRate,
          threshold: threshold.warning,
          totalCanceled,
          netActive,
        });
      }
    }
  }

  private async checkRefundRate(): Promise<void> {
    const window = 24 * 60 * 60 * 1000; // 24 hours
    const cutoff = Date.now() - window;

    const payments = await this.getMetricValues('payment_attempts_total', cutoff);
    const refunds = await this.getMetricValues('refunds_total', cutoff);

    const successfulPayments = payments.filter(p =>
      p.labels?.status === 'success',
    );
    const totalPayments = successfulPayments.reduce((sum, m) => sum + m.value, 0);
    const totalRefunds = refunds.reduce((sum, m) => sum + m.value, 0);

    if (totalPayments > 10) {
      const refundRate = totalRefunds / totalPayments;
      const threshold = this.alertThresholds.get('refund_rate')!;

      if (refundRate >= threshold.critical) {
        await this.triggerAlert('refund_rate', 'critical', {
          refundRate,
          threshold: threshold.critical,
          totalRefunds,
          totalPayments,
        });
      } else if (refundRate >= threshold.warning) {
        await this.triggerAlert('refund_rate', 'warning', {
          refundRate,
          threshold: threshold.warning,
          totalRefunds,
          totalPayments,
        });
      }
    }
  }

  async detectAnomalies(): Promise<PaymentAnomaly[]> {
    const anomalies: PaymentAnomaly[] = [];
    const nowMs = Date.now();
    const oneHour = 60 * 60 * 1000;

    // Detect unusual payment volumes
    const currentHourVolume = await this.getHourlyVolume(nowMs);
    const historicalAverage = await this.getHistoricalAverageVolume();

    if (currentHourVolume > historicalAverage * 3) {
      anomalies.push({
        type: 'unusual_volume',
        severity: 'warning',
        description: `Payment volume ${currentHourVolume} is 3x higher than average ${historicalAverage}`,
        detectedAt: now(),
        metadata: { current: currentHourVolume, average: historicalAverage },
      });
    }

    // Detect sudden spike in failed payments
    const recentFailures = await this.getMetricValues('payment_failures_total', nowMs - oneHour);
    const failureSpike = recentFailures.length > 20;

    if (failureSpike) {
      anomalies.push({
        type: 'failure_spike',
        severity: 'critical',
        description: `Sudden spike in payment failures: ${recentFailures.length} in last hour`,
        detectedAt: now(),
        metadata: { failureCount: recentFailures.length },
      });
    }

    return anomalies;
  }

  async getSystemHealth(): Promise<PaymentSystemHealth> {
    const nowMs = Date.now();
    const oneHour = 60 * 60 * 1000;

    const [paymentSuccessRate, webhookSuccessRate, avgPaymentProcessingTime, avgWebhookProcessingTime] =
      await Promise.all([
        this.calculateSuccessRate('payment_attempts_total', nowMs - oneHour, nowMs),
        this.calculateSuccessRate('webhook_attempts_total', nowMs - oneHour, nowMs),
        this.getAverageMetric('payment_processing_time', nowMs - oneHour, nowMs),
        this.getAverageMetric('webhook_processing_time', nowMs - oneHour, nowMs),
      ]);

    // Calculate overall health score (0-1)
    const overall = this.calculateOverallHealth([
      paymentSuccessRate,
      webhookSuccessRate >= 0.95 ? 1 : webhookSuccessRate,
      avgWebhookProcessingTime < 2000 ? 1 : 0.5,
      avgPaymentProcessingTime < 3000 ? 1 : 0.5,
    ]);

    return {
      overall,
      payments: {
        successRate: paymentSuccessRate,
        avgProcessingTime: avgPaymentProcessingTime,
        activeSubscriptions: await this.getActiveSubscriptionCount(),
      },
      webhooks: {
        avgProcessingTime: avgWebhookProcessingTime,
        successRate: webhookSuccessRate,
      },
      providers: {
        stripe: true, // Would check actual provider health
      },
      lastUpdated: now(),
    };
  }

  private async triggerAlert(
    metricName: string,
    severity: 'warning' | 'critical',
    data: Record<string, unknown>,
  ): Promise<void> {
    const alert: PaymentAlert = {
      id: crypto.randomUUID(),
      metricName,
      severity,
      message: `Payment system alert: ${metricName} ${severity}`,
      data,
      triggeredAt: now(),
      status: 'active',
    };

    // Store alert
    await this.kv.set(`alert:${alert.id}`, alert, 86_400); // 24 hour TTL

    // Send notifications based on severity
    if (this.alertingService) {
      if (severity === 'critical') {
        await this.alertingService.sendCriticalAlert(alert);
      } else {
        await this.alertingService.sendWarningAlert(alert);
      }
    }

    // Log alert
    console.error(`[PAYMENT ALERT] ${severity.toUpperCase()}: ${metricName}`, data);
  }

  private async calculateSuccessRate(metric: string, start: number, _end: number): Promise<number> {
    const values = await this.getMetricValues(metric, start);
    const successful = values.filter(v => v.labels?.status === 'success');
    const total = values.length;

    return total > 0 ? successful.length / total : 0;
  }

  private async getAverageMetric(metric: string, start: number, _end: number): Promise<number> {
    const values = await this.getMetricValues(metric, start);
    if (values.length === 0) return 0;

    return values.reduce((sum, v) => sum + v.value, 0) / values.length;
  }

  private calculateOverallHealth(factors: number[]): number {
    return factors.reduce((sum, f) => sum + f, 0) / factors.length;
  }

  private async getHourlyVolume(timestamp: number): Promise<number> {
    const oneHour = 60 * 60 * 1000;
    const values = await this.getMetricValues('payment_attempts_total', timestamp - oneHour);
    return values.reduce((sum, v) => sum + v.value, 0);
  }

  private async getHistoricalAverageVolume(): Promise<number> {
    // Would calculate from historical data
    // For now, return a placeholder
    return 100;
  }

  private async getActiveSubscriptionCount(): Promise<number> {
    // Would get from database
    // For now, return a placeholder
    return 1000;
  }

  private cleanupOldMetrics(): void {
    const oneHour = 60 * 60 * 1000;
    const cutoff = Date.now() - oneHour;

    for (const [name, values] of this.metrics) {
      const filtered = values.filter(v => v.timestamp >= cutoff);
      this.metrics.set(name, filtered);
    }
  }

  destroy(): void {
    if (this.metricsCollectionInterval) {
      clearInterval(this.metricsCollectionInterval);
    }
  }
}

// Factory function
export function createPaymentMonitoringService(kv: KV, alertingService?: AlertingService) {
  return new PaymentMonitoringService(kv, alertingService);
}