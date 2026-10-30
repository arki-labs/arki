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
