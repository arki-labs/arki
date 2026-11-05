/// <reference types="node" />
/**
 * Publishes, deliveries and SQLite polls are visible in OpenTelemetry without a Dot app, and the
 * spans never carry a channel name or a payload: channels can name a user, payloads are app data.
 * The SQLite backend runs on a real libSQL file, the memory backend on its real bus.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SpanStatusCode } from '@opentelemetry/api';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/payload/sqlite';
import { defineRelations, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CapturedSpan } from '@arki/testing/otel';
import { createLibsqlDb } from '@arki/db/libsql';
import { captureSpans } from '@arki/testing/otel';

import { PUBSUB_ERROR_CODES } from './errors.js';
import { memoryPubSub } from './memory.js';
import { pubsubTable, sqlitePubSub } from './sqlite/index.js';

const CHANNEL = 'user_4711_orders';
const PAYLOAD = 'order 42 for alice@example.com';
/** The only attributes a pubsub span may carry: bounded names, never what the app sent. */
const ALLOWED = new Set(['pubsub.backend', 'pubsub.messages', 'error.type']);

function expectNoAppData(span: CapturedSpan): void {
  for (const [key, value] of Object.entries(span.attributes)) {
    expect(ALLOWED, `attribute ${key}`).toContain(key);
    expect(String(value)).not.toContain(CHANNEL);
    expect(String(value)).not.toContain(PAYLOAD);
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('memory backend telemetry', () => {
  it('spans the publish and each delivery under it, with no SDK beyond the API', async () => {
    using spans = captureSpans();
    const pubsub = memoryPubSub();
    const got: string[] = [];
    await pubsub.subscribe(CHANNEL, payload => {
      got.push(payload);
    });
    await pubsub.publish(CHANNEL, PAYLOAD);
    await sleep(0);
    expect(got).toEqual([PAYLOAD]);

    const publish = spans.named('pubsub.publish');
    const delivery = spans.named('pubsub.deliver');
    expect(publish.attributes['pubsub.backend']).toBe('memory');
    expect(publish.status.code).toBe(SpanStatusCode.UNSET);
    // The memory bus delivers on a microtask queued by the publish: the delivery is its child.
    expect(delivery.parent).toBe(publish);
    expect(delivery.status.code).toBe(SpanStatusCode.UNSET);
    for (const span of spans.finished) expectNoAppData(span);
    await pubsub.close();
  });

  it('marks a delivery failed when the subscriber throws or rejects, and the others still get it', async () => {
    using spans = captureSpans();
    const pubsub = memoryPubSub();
    const got: string[] = [];
    await pubsub.subscribe(CHANNEL, () => {
      throw new TypeError('subscriber bug');
    });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the case under test: an async callback where OnMessage returns void
    await pubsub.subscribe(CHANNEL, () => Promise.reject(new RangeError('async subscriber bug')));
    await pubsub.subscribe(CHANNEL, payload => {
      got.push(payload);
    });
    await pubsub.publish(CHANNEL, PAYLOAD);
    await sleep(5);
    expect(got).toEqual([PAYLOAD]);

    const deliveries = spans.finished.filter(span => span.name === 'pubsub.deliver');
    expect(deliveries.map(span => [span.status.code, span.attributes['error.type']]).toSorted()).toEqual(
      [
        [SpanStatusCode.ERROR, 'RangeError'],
        [SpanStatusCode.ERROR, 'TypeError'],
        [SpanStatusCode.UNSET, undefined],
      ].toSorted(),
    );
    const collected = await spans.collectMetrics();
    const counted = collected.find(metric => metric.descriptor.name === 'pubsub.operations');
    const deliverErrors = counted?.dataPoints.find(
      point => point.attributes['operation'] === 'deliver' && point.attributes['outcome'] === 'error',
    );
    expect(deliverErrors?.value).toBe(2);
    await pubsub.close();
  });

  it('a publish that throws keeps its error and marks the span with the stable error id, not the message', async () => {
    using spans = captureSpans();
    const pubsub = memoryPubSub();
    await pubsub.close();
    await expect(pubsub.publish(CHANNEL, PAYLOAD)).rejects.toMatchObject({ code: 'closed' });
    const publish = spans.named('pubsub.publish');
    expect(publish.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(publish.attributes['error.type']).toBe(PUBSUB_ERROR_CODES.closed);
    expect(publish.events).toEqual([]);
    expectNoAppData(publish);
  });
});

describe('sqlite backend telemetry', () => {
  const table = pubsubTable();
  const folder = mkdtempSync(path.join(tmpdir(), 'arki-pubsub-otel-'));
  const libsql = createLibsqlDb({ url: `file:${path.join(folder, 'pubsub.db')}`, relations: defineRelations({}) });
  const { db } = libsql;

  beforeAll(async () => {
    const statements = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ table }));
    for (const statement of statements) await db.run(sql.raw(statement));
  });

  afterAll(() => {
    libsql.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it('spans publishIn, and the poll that read the row, with the delivery under the poll', async () => {
    using spans = captureSpans();
    const pubsub = sqlitePubSub({ db, intervalMs: 10 });
    const got: string[] = [];
    await pubsub.subscribe(CHANNEL, payload => {
      got.push(payload);
    });
    await sleep(40); // idle polls: counted, never spanned
    expect(spans.finished.filter(span => span.name === 'pubsub.sqlite.poll')).toEqual([]);

    await db.transaction(async tx => {
      await pubsub.publishIn(tx, CHANNEL, PAYLOAD);
    });
    await expect.poll(() => got, { timeout: 2000 }).toEqual([PAYLOAD]);
    await pubsub.close();

    const publishIn = spans.named('pubsub.publish_in');
    expect(publishIn.attributes['pubsub.backend']).toBe('sqlite');
    const poll = spans.named('pubsub.sqlite.poll');
    expect(poll.attributes['pubsub.messages']).toBe(1);
    expect(spans.named('pubsub.deliver').parent).toBe(poll);
    for (const span of spans.finished) expectNoAppData(span);

    const collected = await spans.collectMetrics();
    const counted = collected.find(metric => metric.descriptor.name === 'pubsub.operations');
    const polls = counted?.dataPoints.find(point => point.attributes['operation'] === 'poll');
    expect(polls?.attributes).toEqual({ operation: 'poll', backend: 'sqlite', outcome: 'success' });
    expect(Number(polls?.value)).toBeGreaterThan(1);
  });

  it('a poll whose read fails is spanned as failed, and polling goes on', async () => {
    using spans = captureSpans();
    const working = sqlitePubSub({ db, intervalMs: 10 });
    await working.subscribe(CHANNEL, () => null);
    // The table goes away under a live subscriber: each poll's read throws until it is back.
    await db.run(sql`alter table arki_pubsub rename to arki_pubsub_away`);
    try {
      await expect
        .poll(() => spans.finished.filter(span => span.name === 'pubsub.sqlite.poll').length, { timeout: 2000 })
        .toBeGreaterThan(0);
    } finally {
      await db.run(sql`alter table arki_pubsub_away rename to arki_pubsub`);
    }
    await working.close();
    const failed = spans.finished.find(span => span.name === 'pubsub.sqlite.poll');
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed?.attributes['pubsub.messages']).toBe(0);
    expect(typeof failed?.attributes['error.type']).toBe('string');
  });
});
