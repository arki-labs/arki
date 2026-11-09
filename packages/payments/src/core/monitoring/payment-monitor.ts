import type { Instant } from '@arki/date';
import type { KV } from '@arki/kv';
import type { Money } from '@arki/money';
import { now, sub } from '@arki/date';
import { invariant } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { PaymentRepository } from '../repository.js';
import { observePayments } from '../telemetry.js';

const logger = getLogger('arki:payments:monitor');

/** Metrics older than this are dropped from memory. */
const METRIC_RETENTION_MS = 60 * 60 * 1000;

// AlertingService interface - to be implemented or imported from a shared location
type AlertingService = {
  sendCriticalAlert(alert: unknown): Promise<void>;
  sendWarningAlert(alert: unknown): Promise<void>;
}

/** A KV write that did not go through: `kv.unavailable` on an outage or timeout, `kv.cancelled`. */
type KvWriteFailure = Exclude<Awaited<ReturnType<KV['set']>>, boolean>;

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
    /** Subscriptions whose stored status is `active`. */
    activeSubscriptions: number;
  };
  webhooks: {
    avgProcessingTime: number;
    successRate: number;
  };
  lastUpdated: Instant;
}

/** The stored counts the monitor reads. A `PaymentRepository` fits. */
type MonitorReads = Pick<PaymentRepository, 'getActiveSubscriptionCount' | 'countPaymentsCreatedBetween'>;

/** The precondition of a measured duration: a finite number of milliseconds, 0 or more. */
function assertDuration(value: number, name: string): void {
  invariant(Number.isFinite(value) && value >= 0, () => `[@arki/payments] ${name} must be a finite number of milliseconds, 0 or more`);
}

/** How many past hours the payment volume of the last hour is compared with. */
const VOLUME_HISTORY_HOURS = 24;

/**
 * Counts payment, webhook, subscription and refund outcomes in memory (the last hour) and in KV,
 * and raises an alert when a rate crosses its threshold. It starts no timer: old metrics are
 * dropped when a new one is recorded, so a monitor built per request leaves nothing running.
 */
export class PaymentMonitoringService {
  private metrics = new Map<string, MetricValue[]>();
  private alertThresholds = new Map<string, AlertThreshold>();

  constructor(
    private kv: KV,
    private reads: MonitorReads,
    private alertingService?: AlertingService,
  ) {
    this.initializeThresholds();
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

  /*
   * The record methods keep every metric in memory, so the rates and alerts work while KV is down.
   * Each resolves with nothing when every KV write went through, or with the first KV failure
   * (`kv.unavailable`, `kv.cancelled`) when a metric or an alert was not persisted.
   */

  /**
   * `outcome` (`success` or `failure`) is what the success and refund rates count; `status` is the payment's own.
   * `result.processingTime` is a finite number of milliseconds, 0 or more (a precondition: anything else
   * throws an invariant failure before anything is recorded).
   */
  async recordPaymentAttempt(result: PaymentResult): Promise<KvWriteFailure | undefined> {
    assertDuration(result.processingTime, 'processingTime');
    const outcome = result.success ? 'success' : 'failure';
    const writes = [
      await this.recordMetric('payment_attempts_total', 1, { status: result.status, outcome }),
      await this.recordMetric('payment_processing_time', result.processingTime),
    ];

    if (!result.success) {
      writes.push(
        await this.recordMetric('payment_failures_total', 1, {
          reason: result.errorCode ?? 'unknown',
          provider: result.provider ?? 'unknown',
        }),
        await this.checkFailureRate(),
      );
    }

    // Record revenue metrics
    // A metric is a float gauge per currency: the one place an amount is meant to become a number
    if (result.success && result.amount) {
      writes.push(
        await this.recordMetric('revenue_processed', result.amount.toNumber(), {
          currency: result.amount.currency.code,
          provider: result.provider ?? 'unknown',
        }),
      );
    }
    return writes.find(write => write !== undefined);
  }

  /**
   * `duration` is a finite number of milliseconds, 0 or more (a precondition: anything else throws an
   * invariant failure before anything is recorded).
   */
  async recordWebhookProcessing(duration: number, success: boolean): Promise<KvWriteFailure | undefined> {
    assertDuration(duration, 'duration');
    const outcome = success ? 'success' : 'failure';
    const writes = [
      await this.recordMetric('webhook_processing_time', duration),
      await this.recordMetric('webhook_attempts_total', 1, { status: outcome, outcome }),
    ];

    const threshold = this.alertThresholds.get('webhook_processing_time');
    if (threshold && duration > threshold.warning) {
      writes.push(await this.checkWebhookPerformance());
    }
    return writes.find(write => write !== undefined);
  }

  async recordSubscriptionEvent(
    event: 'created' | 'canceled' | 'upgraded' | 'downgraded',
  ): Promise<KvWriteFailure | undefined> {
    const writes = [await this.recordMetric(`subscription_${event}_total`, 1)];

    if (event === 'canceled') {
      writes.push(await this.checkChurnRate());
    }
    return writes.find(write => write !== undefined);
  }

  async recordRefund(amount: Money, reason: string): Promise<KvWriteFailure | undefined> {
    const writes = [
      await this.recordMetric('refunds_total', 1, { reason }),
      await this.recordMetric('refund_amount_total', amount.toNumber(), { currency: amount.currency.code }),
      await this.checkRefundRate(),
    ];
    return writes.find(write => write !== undefined);
  }

  private async recordMetric(
    name: string,
    value: number,
    labels?: Record<string, string>,
  ): Promise<KvWriteFailure | undefined> {
    const metric: MetricValue = {
      value,
      timestamp: Date.now(),
      labels,
    };

    // Store in memory, dropping what is older than the retention window
    this.cleanupOldMetrics();
    const values = this.metrics.get(name) ?? [];
    values.push(metric);
    this.metrics.set(name, values);

    // Also store in KV for persistence. A refused write keeps the in-memory metric: the
    // rates still work, only the persisted copy is missing, so it is a WARN and the failure is returned.
    const key = `metrics:${name}:${Date.now()}`;
    const stored = await this.kv.set(key, metric, 3600); // TTL 1 hour
    if (stored === true) return undefined;
    logger.warn('Metric {name} was not stored in KV ({code}); it is kept in memory only', {
      name,
      code: stored === false ? 'refused' : stored.code,
    });
    return stored === false ? undefined : stored;
  }

  private async getMetricValues(name: string, since: number): Promise<MetricValue[]> {
    const values = this.metrics.get(name) || [];
    return values.filter(v => v.timestamp >= since);
  }

  private async checkFailureRate(): Promise<KvWriteFailure | undefined> {
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
        return this.triggerAlert('payment_failure_rate', 'critical', {
          current: failureRate,
          threshold: threshold.critical,
          window: '5 minutes',
          totalAttempts,
          totalFailures,
        });
      } else if (failureRate >= threshold.warning) {
        return this.triggerAlert('payment_failure_rate', 'warning', {
          current: failureRate,
          threshold: threshold.warning,
          window: '5 minutes',
          totalAttempts,
          totalFailures,
        });
      }
    }
    return undefined;
  }

  private async checkWebhookPerformance(): Promise<KvWriteFailure | undefined> {
    const window = 60 * 1000; // 1 minute
    const cutoff = Date.now() - window;

    const processingTimes = await this.getMetricValues('webhook_processing_time', cutoff);
    if (processingTimes.length === 0) return undefined;

    const avgTime = processingTimes.reduce((sum, m) => sum + m.value, 0) / processingTimes.length;
    const threshold = this.alertThresholds.get('webhook_processing_time')!;

    if (avgTime >= threshold.critical) {
      return this.triggerAlert('webhook_processing_time', 'critical', {
        avgTime,
        threshold: threshold.critical,
        sampleSize: processingTimes.length,
      });
    } else if (avgTime >= threshold.warning) {
      return this.triggerAlert('webhook_processing_time', 'warning', {
        avgTime,
        threshold: threshold.warning,
        sampleSize: processingTimes.length,
      });
    }
    return undefined;
  }

  private async checkChurnRate(): Promise<KvWriteFailure | undefined> {
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
        return this.triggerAlert('subscription_churn_rate', 'critical', {
          churnRate,
          threshold: threshold.critical,
          totalCanceled,
          netActive,
        });
      } else if (churnRate >= threshold.warning) {
        return this.triggerAlert('subscription_churn_rate', 'warning', {
          churnRate,
          threshold: threshold.warning,
          totalCanceled,
          netActive,
        });
      }
    }
    return undefined;
  }

  private async checkRefundRate(): Promise<KvWriteFailure | undefined> {
    const window = 24 * 60 * 60 * 1000; // 24 hours
    const cutoff = Date.now() - window;

    const payments = await this.getMetricValues('payment_attempts_total', cutoff);
    const refunds = await this.getMetricValues('refunds_total', cutoff);

    const successfulPayments = payments.filter(p => p.labels?.outcome === 'success');
    const totalPayments = successfulPayments.reduce((sum, m) => sum + m.value, 0);
    const totalRefunds = refunds.reduce((sum, m) => sum + m.value, 0);

    if (totalPayments > 10) {
      const refundRate = totalRefunds / totalPayments;
      const threshold = this.alertThresholds.get('refund_rate')!;

      if (refundRate >= threshold.critical) {
        return this.triggerAlert('refund_rate', 'critical', {
          refundRate,
          threshold: threshold.critical,
          totalRefunds,
          totalPayments,
        });
      } else if (refundRate >= threshold.warning) {
        return this.triggerAlert('refund_rate', 'warning', {
          refundRate,
          threshold: threshold.warning,
          totalRefunds,
          totalPayments,
        });
      }
    }
    return undefined;
  }

  async detectAnomalies(): Promise<PaymentAnomaly[]> {
    const anomalies: PaymentAnomaly[] = [];
    const nowMs = Date.now();
    const oneHour = 60 * 60 * 1000;

    // Detect unusual payment volumes: the payments stored in the last hour against the hourly average
    // of the hours before. With no history there is nothing to compare with.
    const current = now();
    const hourAgo = sub(current, { hours: 1 });
    const [currentHourVolume, historyVolume] = await Promise.all([
      this.reads.countPaymentsCreatedBetween(hourAgo, current),
      this.reads.countPaymentsCreatedBetween(sub(hourAgo, { hours: VOLUME_HISTORY_HOURS }), hourAgo),
    ]);
    const historicalAverage = historyVolume / VOLUME_HISTORY_HOURS;

    if (historicalAverage > 0 && currentHourVolume > historicalAverage * 3) {
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
        activeSubscriptions: await this.reads.getActiveSubscriptionCount(),
      },
      webhooks: {
        avgProcessingTime: avgWebhookProcessingTime,
        successRate: webhookSuccessRate,
      },
      lastUpdated: now(),
    };
  }

  private async triggerAlert(
    metricName: string,
    severity: 'warning' | 'critical',
    data: Record<string, number | string>,
  ): Promise<KvWriteFailure | undefined> {
    const alert: PaymentAlert = {
      id: crypto.randomUUID(),
      metricName,
      severity,
      message: `Payment system alert: ${metricName} ${severity}`,
      data,
      triggeredAt: now(),
      status: 'active',
    };

    // Store alert. A refused write still sends and logs the alert: losing the stored copy must not hide it.
    const stored = await this.kv.set(`alert:${alert.id}`, alert, 86_400); // 24 hour TTL
    if (stored !== true) {
      logger.warn('Alert {alertId} ({metricName}) was not stored in KV ({code})', {
        alertId: alert.id,
        metricName,
        code: stored === false ? 'refused' : stored.code,
      });
    }

    // Send notifications based on severity
    const alertingService = this.alertingService;
    if (alertingService) {
      await observePayments('alert', { 'payments.alert': metricName, 'payments.severity': severity }, () =>
        severity === 'critical' ? alertingService.sendCriticalAlert(alert) : alertingService.sendWarningAlert(alert),
      );
    }

    // Log alert
    const line = 'Payment alert {severity}: {metricName}';
    if (severity === 'critical') {
      logger.error(line, { severity, metricName, data });
    } else {
      logger.warn(line, { severity, metricName, data });
    }
    return stored === true || stored === false ? undefined : stored;
  }

  private async calculateSuccessRate(metric: string, start: number, _end: number): Promise<number> {
    const values = await this.getMetricValues(metric, start);
    const successful = values.filter(v => v.labels?.outcome === 'success');
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

  private cleanupOldMetrics(): void {
    const cutoff = Date.now() - METRIC_RETENTION_MS;

    for (const [name, values] of this.metrics) {
      const filtered = values.filter(v => v.timestamp >= cutoff);
      this.metrics.set(name, filtered);
    }
  }

}

// Factory function
export function createPaymentMonitoringService(kv: KV, reads: MonitorReads, alertingService?: AlertingService) {
  return new PaymentMonitoringService(kv, reads, alertingService);
}