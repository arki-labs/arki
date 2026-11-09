/**
 * Webhook alerts go through the package logger, never the console
 *
 * A library that writes to `console` floods an app's output and skips its log routing. An alert is
 * kept for `getActiveAlerts` and logged at WARN under `arki:payments:webhook`, without its data.
 */
import type { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FAILURE_ERROR_CODES, orThrow } from '@arki/failure';

import { core, openDb } from '../../test-support.js';
import { PaymentRepository } from '../repository.js';
import { WebhookAnalyticsService } from './webhook-analytics-service.js';

const relations = defineRelations({ webhookEvents: core.webhookEvents }, () => ({}));

let client: PGlite;
let service: WebhookAnalyticsService;

beforeAll(async () => {
  ({ client } = await openDb());
  service = new WebhookAnalyticsService(new PaymentRepository(drizzle({ client, relations }), core));
});

afterAll(async () => {
  await client.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WebhookAnalyticsService.createAlert', () => {
  it('keeps the alert and writes nothing to the console', () => {
    const consoleCalls = (['log', 'info', 'warn', 'error'] as const).map(method => vi.spyOn(console, method));

    service.createAlert('slow_processing', 'high', 'Slow webhook processing detected: 16000ms', {
      processingTime: 16_000,
    });

    expect(service.getActiveAlerts()).toMatchObject([
      { type: 'slow_processing', severity: 'high', data: { processingTime: 16_000 } },
    ]);
    for (const call of consoleCalls) {
      expect(call).not.toHaveBeenCalled();
    }
  });
});

describe('WebhookAnalyticsService.getWebhookMetrics', () => {
  it('counts processed events too, so a healthy stream does not read as a 0% processing rate', async () => {
    const repository = new PaymentRepository(drizzle({ client, relations }), core);
    const processed = orThrow(
      await repository.createWebhookEvent({
        provider: 'stripe',
        eventType: 'customer.created',
        providerEventId: 'evt_metrics_done',
        data: {},
      }),
    );
    orThrow(await repository.markWebhookEventAsProcessed(processed.id));
    orThrow(
      await repository.createWebhookEvent({
        provider: 'stripe',
        eventType: 'customer.created',
        providerEventId: 'evt_metrics_open',
        data: {},
      }),
    );

    const metrics = await service.getWebhookMetrics();

    expect(metrics).toMatchObject({ totalEvents: 2, processedEvents: 1, processingRate: 50 });
  });
});

describe('WebhookAnalyticsService refuses numbers it cannot use', () => {
  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'recordProcessingTime(%s) breaks the stated precondition and records nothing',
    processingTime => {
      const fresh = new WebhookAnalyticsService(new PaymentRepository(drizzle({ client, relations }), core));

      expect(() => fresh.recordProcessingTime(processingTime)).toThrow(
        expect.objectContaining({ code: FAILURE_ERROR_CODES.invariant }),
      );
      expect(fresh.getAllAlerts()).toEqual([]);
    },
  );

  it.each([
    ['a NaN error rate', { errorRate: Number.NaN, slowProcessing: 5000, maxAlerts: 100 }],
    ['a negative slow-processing time', { errorRate: 5, slowProcessing: -1, maxAlerts: 100 }],
    ['a fractional alert count', { errorRate: 5, slowProcessing: 5000, maxAlerts: 1.5 }],
    ['no room for any alert', { errorRate: 5, slowProcessing: 5000, maxAlerts: 0 }],
  ])('%s fails when the service is built, as payments.configuration_invalid', (_what, thresholds) => {
    expect(
      () => new WebhookAnalyticsService(new PaymentRepository(drizzle({ client, relations }), core), thresholds),
    ).toThrow(expect.objectContaining({ code: 'payments.configuration_invalid' }));
  });
});
