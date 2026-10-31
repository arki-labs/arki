/**
 * PaymentMonitoringService reads stored counts
 *
 * Active subscriptions and payment volume come from the database, not from a constant or an
 * in-memory counter. These tests use a real PaymentRepository on PGlite. The monitor writes
 * nothing to KV here, so the KV client never connects.
 */
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { now, sub } from '@arki/date';
import { orThrow } from '@arki/failure';
import { KV } from '@arki/kv';

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
