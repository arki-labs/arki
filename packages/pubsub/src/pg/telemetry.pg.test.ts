/**
 * On a real Postgres (container; `bun run test:pg`): `publish` and `publishIn` get their own spans,
 * a delivery gets one per subscriber, and listening stays `@arki/db`'s `db.listen.start` alone, so
 * a channel is never spanned twice.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SpanStatusCode } from '@opentelemetry/api';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { captureSpans } from '@arki/testing/otel';

import { pgPubSub } from './index.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 5 });
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

it('spans publish, publishIn and the delivery; the listen is db.listen.start only; no channel or payload is recorded', async () => {
  using spans = captureSpans();
  const pubsub = pgPubSub({ pool });
  const got: string[] = [];
  const unsubscribe = await pubsub.subscribe('user_4711_orders', payload => {
    got.push(payload);
  });
  if (typeof unsubscribe !== 'function') throw new Error(`subscribe failed: ${unsubscribe.code}`);
  await pubsub.publish('user_4711_orders', 'secret one');
  await drizzle({ client: pool }).transaction(async tx => {
    await pubsub.publishIn(tx, 'user_4711_orders', 'secret two');
  });
  await expect.poll(() => got.length, { timeout: 5000 }).toBe(2);
  await pubsub.close();

  const names = spans.finished.map(span => span.name);
  expect(names.filter(name => name === 'db.listen.start')).toHaveLength(1);
  expect(names.filter(name => name.startsWith('pubsub.') && name.includes('listen'))).toEqual([]);
  const publish = spans.named('pubsub.publish');
  const publishIn = spans.named('pubsub.publish_in');
  for (const span of [publish, publishIn]) {
    expect(span.attributes).toEqual({ 'pubsub.backend': 'pg' });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  }
  const deliveries = spans.finished.filter(span => span.name === 'pubsub.deliver');
  expect(deliveries).toHaveLength(2);
  for (const span of deliveries) expect(span.attributes).toEqual({ 'pubsub.backend': 'pg' });
});
