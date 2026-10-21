import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { defineFailure, InvalidEnvelope, InvalidInput, reviveJson, serialize } from '@arki/failure';

import { routes } from '../bundle.js';
import { createClient } from '../client.js';
import { route } from '../contract.js';
import { buildEngine } from '../compiled.js';
import { orThrowHttp, toErrorResponse } from '../error.js';
import { IdempotencyInProgress, NetworkFailure } from '../failures.js';

const Missing = defineFailure('catalog.missing', { status: 404, data: z.object({ id: z.string().min(2) }) });
const definitions = [Missing] as const;
const lookup = route.get('/catalog/:id', { id: 'catalog.lookup', failures: definitions });

describe('owned HTTP boundaries', () => {
  it('uses the same definition across HTTP and a worker JSON message without remote presentation metadata', async () => {
    const engine = buildEngine([routes().bind(lookup, ({ params }) => Missing({ id: params.id }))]);
    const call = createClient(lookup, {
      baseUrl: 'http://test',
      fetch: (url, init) => engine.fetch(new Request(url, init)),
    });
    const result = await call({ params: { id: 'absent' } });
    if (!Missing.is(result)) throw new Error('Expected the declared catalog failure');
    const worker = reviveJson(JSON.stringify(serialize(result, definitions)), definitions);
    expect(worker).toEqual(result);
    expectTypeOf(result).toEqualTypeOf<ReturnType<typeof Missing>>();
  });

  it('refuses invalid known failure data at the server before the wire can carry it', async () => {
    const engine = buildEngine([routes().bind(lookup, () => Missing({ id: 'x' }))]);
    const response = await engine.fetch(new Request('http://test/catalog/xx'));
    expect(await response.json()).toMatchObject({
      error: { code: InvalidEnvelope.code, data: { reason: 'invalid_data' } },
    });
  });

  it('returns invalid input to the caller before sending and after server validation', async () => {
    const input = route.get('/input', { id: 'input', query: { count: z.string().min(2) } });
    let calls = 0;
    const engine = buildEngine([
      routes().bind(input, () => {
        calls += 1;
      }),
    ]);
    const response = await engine.fetch(new Request('http://test/input?count=x'));
    expect(await response.json()).toMatchObject({ error: { code: InvalidInput.code } });
    const call = createClient(input, {
      baseUrl: 'http://test',
      fetch: (url, init) => engine.fetch(new Request(url, init)),
    });
    expect(InvalidInput.is(await call({ query: { count: 'x' } }))).toBe(true);
    expect(calls).toBe(0);
  });

  it('classifies malformed request JSON as input rather than an unknown wire code', async () => {
    const write = route.post('/write', { id: 'write', body: z.object({ id: z.string() }) });
    const engine = buildEngine([
      routes().bind(write, () => {
        throw new Error('Invalid input must be rejected before execution');
      }),
    ]);
    const response = await engine.fetch(new Request('http://test/write', { method: 'POST', body: '{' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: InvalidInput.code, data: { issues: [{ path: ['body'] }] } },
    });
  });

  it('classifies a fetch rejection without exposing its private cause in JSON', async () => {
    const call = createClient(lookup, {
      baseUrl: 'http://test',
      fetch: () => Promise.reject(new TypeError('secret-token')),
    });
    const result = await call({ params: { id: 'absent' } });
    expect(NetworkFailure.is(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('keeps middleware failures explicit on contracts and preserves retry headers at the exception bridge', () => {
    let caught: unknown;
    try {
      orThrowHttp(IdempotencyInProgress(), [IdempotencyInProgress], { headers: { 'retry-after': '1' } });
    } catch (error) {
      caught = error;
    }
    const response = toErrorResponse(caught);
    expect(response.status).toBe(409);
    expect(response.headers.get('retry-after')).toBe('1');
  });

  it('does not erase an unsupported failure protocol version while decoding the HTTP envelope', async () => {
    const call = createClient(lookup, {
      baseUrl: 'http://test',
      fetch: () =>
        Promise.resolve(
          Response.json(
            { error: { version: 2, code: Missing.code, message: 'remote', data: { id: 'xx' } } },
            { status: 404 },
          ),
        ),
    });
    expect(await call({ params: { id: 'xx' } })).toMatchObject({
      code: InvalidEnvelope.code,
      data: { reason: 'unsupported_version' },
    });
  });

  it('requires every bridge failure to be listed', () => {
    const compileOnly = () => {
      // @ts-expect-error -- the boundary must declare the catalog failure it can throw
      orThrowHttp(Missing({ id: 'xx' }), [IdempotencyInProgress]);
    };
    expectTypeOf(compileOnly).toBeFunction();
  });
});
