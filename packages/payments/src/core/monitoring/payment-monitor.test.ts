/**
 * PaymentMonitoringService reads stored counts
 *
 * Active subscriptions and payment volume come from the database, not from a constant or an
 * in-memory counter. These tests use a real PaymentRepository on PGlite. The KV points at a port
 * nothing listens on, so every KV write fails the way a Redis outage does (`kv.unavailable` after the
 * command timeout): the record methods must keep the metric in memory and return the KV failure.
 */
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';
import { now, sub } from '@arki/date';
import { FAILURE_ERROR_CODES, orThrow } from '@arki/failure';
import { KV } from '@arki/kv';
import { money } from '@arki/money';

import type { AppDb } from '../../test-support.js';
import { runnerOn, seedPayment, seedSubscription } from '../../service-test-support.js';
import { core, openDb, typed } from '../../test-support.js';
import { PaymentRepository } from '../repository.js';
import { PaymentMonitoringService } from './payment-monitor.js';

let db: AppDb;
let client: PGlite;
let kv: KV;
let writes: ReturnType<typeof typed.core.writes>;
let monitor: PaymentMonitoringService;

beforeEach(async () => {
  ({ db, client } = await openDb());
  writes = typed.core.writes(runnerOn(db));
  kv = new KV('redis://127.0.0.1:1');
  monitor = new PaymentMonitoringService(kv, new PaymentRepository(db, core));
});

afterEach(async () => {
  orThrow(await kv.close());
  await client.close();
});

describe('getSystemHealth', () => {
  it('reports the stored count of active subscriptions and no providers', async () => {
    await seedSubscription(writes, 'active');
    await seedSubscription(writes, 'active');
    await seedSubscription(writes, 'active');
    await seedSubscription(writes, 'canceled');

    const health = await monitor.getSystemHealth();

    expect(health.payments.activeSubscriptions).toBe(3);
    expect(Object.keys(health)).not.toContain('providers');
  });
});

describe('detectAnomalies', () => {
  it('flags unusual volume when the last hour has more than 3x the hourly average of the 24 hours before', async () => {
    // 24 payments, one per hour, 1.5 to 24.5 hours ago: an average of 1 per hour
    for (let hour = 0; hour < 24; hour += 1) {
      const payment = await seedPayment(writes, null);
      await db
        .update(core.payments)
        .set({ createdAt: sub(now(), { minutes: hour * 60 + 90 }) })
        .where(eq(core.payments.id, payment.id));
    }
    for (let index = 0; index < 4; index += 1) await seedPayment(writes, null);

    const anomalies = await monitor.detectAnomalies();

    expect(anomalies.map(anomaly => anomaly.type)).toEqual(['unusual_volume']);
  });

  it('flags nothing when all payments are from the last hour and there is no history', async () => {
    for (let index = 0; index < 10; index += 1) await seedPayment(writes, null);

    expect(await monitor.detectAnomalies()).toEqual([]);
  });
});

/** A monitor whose KV is down: each write gives up after 50 ms with `kv.unavailable`. */
let down: KV;
function monitorWithKvDown(alertingService?: ConstructorParameters<typeof PaymentMonitoringService>[2]) {
  down = new KV('redis://127.0.0.1:1', undefined, undefined, { commandTimeoutMs: 50 });
  return new PaymentMonitoringService(down, new PaymentRepository(db, core), alertingService);
}

describe('record methods while KV is down', () => {
  afterEach(async () => {
    // The store never answered, so closing it can time out too
    const closed = await down.close();
    expect([undefined, 'kv.close_failed']).toContain(closed?.code);
  });

  it('returns kv.unavailable when a metric cannot be stored, and keeps the metric in memory', async () => {
    const monitor = monitorWithKvDown();
    const stored = await monitor.recordPaymentAttempt({ success: true, status: 'succeeded', processingTime: 120 });

    const health = await monitor.getSystemHealth();

    expect(stored).toMatchObject({ code: 'kv.unavailable' });
    expect(health.payments.successRate).toBe(1);
  });

  it('returns kv.unavailable from every record method', async () => {
    const monitor = monitorWithKvDown();
    expect(await monitor.recordWebhookProcessing(10, true)).toMatchObject({ code: 'kv.unavailable' });
    expect(await monitor.recordSubscriptionEvent('created')).toMatchObject({ code: 'kv.unavailable' });
    expect(await monitor.recordRefund(money('5.00', 'USD'), 'customer_request')).toMatchObject({
      code: 'kv.unavailable',
    });
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'a duration of %s breaks the stated precondition, and nothing is recorded',
    async duration => {
      const monitor = monitorWithKvDown();

      await expect(monitor.recordWebhookProcessing(duration, true)).rejects.toMatchObject({
        code: FAILURE_ERROR_CODES.invariant,
      });
      await expect(
        monitor.recordPaymentAttempt({ success: true, status: 'succeeded', processingTime: duration }),
      ).rejects.toMatchObject({ code: FAILURE_ERROR_CODES.invariant });

      const health = await monitor.getSystemHealth();
      expect(health.payments).toMatchObject({ successRate: 0, avgProcessingTime: 0 });
      expect(health.webhooks).toMatchObject({ successRate: 0, avgProcessingTime: 0 });
    },
  );

  it('counts an attempt as successful by its outcome, whatever the payment status is called', async () => {
    const monitor = monitorWithKvDown();
    const stored = [
      await monitor.recordPaymentAttempt({ success: true, status: 'succeeded', processingTime: 100 }),
      await monitor.recordPaymentAttempt({ success: false, status: 'failed', processingTime: 100 }),
    ];
    const health = await monitor.getSystemHealth();

    expect(stored.map(result => result?.code)).toEqual(['kv.unavailable', 'kv.unavailable']);
    expect(health.payments.successRate).toBe(0.5);
  });

  it('alerts on the refund rate of the successful payments of the last day', async () => {
    // The app's own alert channel: it receives what the monitor sends
    const alertSchema = z.object({ metricName: z.string(), severity: z.string() });
    const alerts: z.output<typeof alertSchema>[] = [];
    const record = (alert: unknown) => {
      alerts.push(alertSchema.parse(alert));
      return Promise.resolve();
    };
    const alerting = monitorWithKvDown({ sendCriticalAlert: record, sendWarningAlert: record });
    const stored = [];
    for (let index = 0; index < 11; index += 1) {
      stored.push(await alerting.recordPaymentAttempt({ success: true, status: 'succeeded', processingTime: 100 }));
    }

    // 1 of 11 is under the 10% warning, 2 of 11 is a warning, 3 of 11 is past the 20% critical line
    for (let index = 0; index < 3; index += 1) {
      stored.push(await alerting.recordRefund(money('5.00', 'USD'), 'customer_request'));
    }

    // KV is down, so nothing was persisted, but the alerts still went out from memory
    expect(new Set(stored.map(result => result?.code))).toEqual(new Set(['kv.unavailable']));
    expect(alerts.map(alert => [alert.metricName, alert.severity])).toEqual([
      ['refund_rate', 'warning'],
      ['refund_rate', 'critical'],
    ]);
  });
});
