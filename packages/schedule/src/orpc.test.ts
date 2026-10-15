/**
 * `@arki/schedule/orpc` — cron procedures served through oRPC's OpenAPI
 * handler. What these tests guard: the wire carries exactly what the policy
 * says, byte for byte. Coolify (or any cron caller) and on-call read these
 * bodies; oRPC's JSON envelope must never reach them, and a body's key order
 * is the run's, not the schema's.
 */
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { feature } from '@arki/dot/feature';
import { service } from '@arki/dot/plugin';

import type { ScheduleOutcome } from './dot.js';
import type { CronContext } from './orpc.js';
import { schedules } from './dot.js';
import { checkOnly, cronErrorBody, cronRouterFor, defineCronContract, fail, ok, rethrow, skipped } from './orpc.js';

type Clock = { readonly now: () => number };
const needs = { clock: service<Clock>() };

/** Three value shapes: exactly the body, a value that needs a mapping, and one with a legacy lock-held body. */
const reader = feature('reader', {
  needs,
  use: [
    schedules(needs, [
      { name: 'gate', every: '1m', handler: ({ clock }) => ({ gated: clock.now(), skipped: 1 }) },
      {
        name: 'retain',
        every: '1m',
        handler: ({ clock }): { ok: true; body: { purged: number } } | { ok: false; error: string } =>
          clock.now() > 0 ? { ok: true, body: { purged: 4 } } : { ok: false, error: 'pool timed out' },
      },
      { name: 'items', every: '1m', handler: () => ({ processed: 7, failed: 0, durationMs: 120 }) },
    ]),
  ],
});
const features = [reader] as const;

// Keys on purpose NOT in the value's order: the wire must keep the value's order anyway.
const contract = defineCronContract({
  gate: z.object({ skipped: z.number(), gated: z.number() }),
  retain: z.object({ purged: z.number() }),
  items: {
    body: z.object({ durationMs: z.number(), processed: z.number(), failed: z.number() }),
    skipped: { skipped: true, reason: 'lock-held' },
  },
});

const cronImplementer = implement(contract).$context<CronContext>();
const router = cronRouterFor(cronImplementer, contract, features, {
  respond: { retain: v => (v.ok ? ok(v.body) : fail(500, { error: v.error })) },
  skipped: () => skipped(),
  failed: (_name, cause) => rethrow(cause),
  unavailable: () => fail(503, { error: 'schedule unavailable' }),
});
const handler = new OpenAPIHandler(router, { customErrorResponseBodyEncoder: cronErrorBody });

type Shot = { readonly status: number; readonly text: string; readonly type: string | null; readonly carried: unknown };

async function post(name: string, outcome: ScheduleOutcome<unknown>): Promise<Shot> {
  const carry: CronContext['carry'] = {};
  const context: CronContext = {
    headers: new Headers(),
    schedules: { trigger: () => Promise.resolve(outcome) },
    carry,
  };
  const request = new Request(`https://app.test/api/cron/${name}`, { method: 'POST' });
  try {
    const { response } = await handler.handle(request, { prefix: '/api/cron', context });
    if (!response) throw new Error(`no procedure for ${name}`);
    return {
      status: response.status,
      text: await response.text(),
      type: response.headers.get('content-type'),
      carried: carry.rethrow?.cause,
    };
  } catch (error) {
    return { status: -1, text: '', type: null, carried: carry.rethrow?.cause ?? error };
  }
}

describe('cron procedures on the wire', () => {
  it('answers a run with the value as produced: same bytes, key order kept', async () => {
    const shot = await post('gate', { name: 'gate', status: 'ran', value: { gated: 3, skipped: 1 } });
    expect(shot).toMatchObject({ status: 200, text: '{"gated":3,"skipped":1}', type: 'application/json' });
  });

  it('maps a value through `respond`, including a 500 answered from a value', async () => {
    const good = await post('retain', { name: 'retain', status: 'ran', value: { ok: true, body: { purged: 4 } } });
    const bad = await post('retain', { name: 'retain', status: 'ran', value: { ok: false, error: 'pool timed out' } });
    expect(good).toMatchObject({ status: 200, text: '{"purged":4}' });
    // The policy's body exactly — not `{"code":"INTERNAL_SERVER_ERROR",...}`.
    expect(bad).toMatchObject({ status: 500, text: '{"error":"pool timed out"}', type: 'application/json' });
  });

  it('answers an overlap or a held lock with the cron lock-held body', async () => {
    const gate = await post('gate', { name: 'gate', status: 'skipped-lock' });
    const items = await post('items', { name: 'items', status: 'skipped-overlap' });
    expect(gate).toMatchObject({ status: 200, text: '{"skipped":"lock-held"}' });
    expect(items).toMatchObject({ status: 200, text: '{"skipped":true,"reason":"lock-held"}' });
  });

  it('carries a failed run out of oRPC, so the host answers and reports it', async () => {
    const cause = new Error('boom');
    const shot = await post('gate', { name: 'gate', status: 'handler-failed', cause });
    expect(shot.carried).toBe(cause);
  });

  it('answers 503 with the policy body when the scheduler cannot run it', async () => {
    const shot = await post('gate', { name: 'gate', status: 'unavailable' });
    expect(shot).toMatchObject({ status: 503, text: '{"error":"schedule unavailable"}', type: 'application/json' });
  });

  it('rejects a value its body schema does not accept (a bug, caught before the wire)', async () => {
    const shot = await post('gate', { name: 'gate', status: 'ran', value: { gated: 'three', skipped: 1 } });
    expect(shot.status).toBe(500);
  });

  it('serves POST /<name> only', () => {
    expect(contract.gate['~orpc'].route).toMatchObject({ method: 'POST', path: '/gate', outputStructure: 'detailed' });
  });
});

describe('checkOnly', () => {
  it('returns the original value, not the schema-rebuilt one', async () => {
    const value = { b: 1, a: 2, extra: true };
    const result = await checkOnly(z.object({ a: z.number(), b: z.number() }))['~standard'].validate(value);
    expect(result).toEqual({ value });
    expect('value' in result && result.value).toBe(value);
  });

  it('passes issues through', async () => {
    const result = await checkOnly(z.object({ a: z.number() }))['~standard'].validate({ a: 'x' });
    expect('issues' in result && result.issues?.length).toBe(1);
  });
});

/* The rejections `cronRouterFor` must give, at compile time. */
const policy = {
  respond: {},
  skipped: () => skipped(),
  failed: (_n: string, e: unknown) => rethrow(e),
  unavailable: () => fail(503, {}),
};
const osOf = <C extends object>(c: C) => implement(c as Record<string, never>).$context<CronContext>();

// 1. a cron name no feature schedule declares
const c1 = defineCronContract({ nope: z.object({}) });
// @ts-expect-error 'nope' is not a schedule of any feature
cronRouterFor(osOf(c1), c1, features, policy);

// 2. a MISSING key: { gated } vs the value { gated, skipped } — zod would silently strip `skipped`
const c2 = defineCronContract({ gate: z.object({ gated: z.number() }) });
// @ts-expect-error missing key → 'gate' becomes a required respond
cronRouterFor(osOf(c2), c2, features, policy);

// 3. an EXTRA key
const c3 = defineCronContract({ gate: z.object({ gated: z.number(), skipped: z.number(), extra: z.string() }) });
// @ts-expect-error extra key → 'gate' becomes a required respond
cronRouterFor(osOf(c3), c3, features, policy);

// 4. a respond whose Ok body is not the schema: answers `v` instead of `v.body`
const c4 = defineCronContract({ retain: z.object({ purged: z.number() }) });
// @ts-expect-error Ok body { ok, body } | { ok, error } is not { purged }
cronRouterFor(osOf(c4), c4, features, { ...policy, respond: { retain: v => ok(v) } });

// 5. a respond that invents a key: Ok is invariant, so { purged, extra } is not an Ok<{ purged }>
cronRouterFor(osOf(c4), c4, features, {
  ...policy,
  // @ts-expect-error extra key in the Ok body
  respond: { retain: v => (v.ok ? ok({ ...v.body, extra: 1 }) : fail(500, {})) },
});

// Accepted: exact body, exact unwrap.
const c6 = defineCronContract({
  gate: z.object({ gated: z.number(), skipped: z.number() }),
  retain: z.object({ purged: z.number() }),
});
cronRouterFor(osOf(c6), c6, features, {
  ...policy,
  respond: { retain: v => (v.ok ? ok(v.body) : fail(500, { error: v.error })) },
});
