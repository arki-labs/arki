import { expectTypeOf, it } from 'vitest';

import type { Failure, FailureOf } from '@arki/failure';
import type { SchemaOutput } from '@arki/schema';

import type { RouteFailure } from '../contract.js';
import type { HttpClientFailure } from '../failures.js';
import type {
  BeginResult,
  IdempotencyOwnerId,
  RESPONSE_CACHE_ABANDON_FAILURES,
  RESPONSE_CACHE_BEGIN_FAILURES,
  RESPONSE_CACHE_FINISH_FAILURES,
  ResponseCache,
  storedResponse,
  StoredResponse,
} from '../idempotency.js';
import { createClient } from '../client.js';
import { route } from '../contract.js';
import { IDEMPOTENCY_FAILURES } from '../idempotency.js';

it('keeps the shared replay schema exactly equal to the stored response type', () => {
  expectTypeOf<SchemaOutput<typeof storedResponse>>().toEqualTypeOf<StoredResponse>();
});

it('infers exact operation failures from their source tuples without widening to a generic failure', () => {
  expectTypeOf<Awaited<ReturnType<ResponseCache['begin']>>>().toEqualTypeOf<
    BeginResult | ReturnType<(typeof RESPONSE_CACHE_BEGIN_FAILURES)[number]>
  >();
  expectTypeOf<Awaited<ReturnType<ResponseCache['finish']>>>().toEqualTypeOf<void | ReturnType<
    (typeof RESPONSE_CACHE_FINISH_FAILURES)[number]
  >>();
  expectTypeOf<Awaited<ReturnType<ResponseCache['abandon']>>>().toEqualTypeOf<void | ReturnType<
    (typeof RESPONSE_CACHE_ABANDON_FAILURES)[number]
  >>();
  expectTypeOf<Parameters<ResponseCache['begin']>>().toEqualTypeOf<
    [key: string, fingerprint: string, owner: IdempotencyOwnerId]
  >();
  expectTypeOf<Parameters<ResponseCache['finish']>>().toEqualTypeOf<
    [key: string, owner: IdempotencyOwnerId, response: StoredResponse, ttl: number]
  >();
  expectTypeOf<Failure>().not.toExtend<FailureOf<ResponseCache['begin']>>();
  expectTypeOf<Failure>().not.toExtend<FailureOf<ResponseCache['finish']>>();
  expectTypeOf<Failure>().not.toExtend<FailureOf<ResponseCache['abandon']>>();
});

it('infers the declared idempotency failures through the typed route client', () => {
  const write = route.post('/write', { id: 'write', failures: IDEMPOTENCY_FAILURES });
  const _call = createClient(write, { baseUrl: 'http://test' });
  expectTypeOf<RouteFailure<typeof write>>().toEqualTypeOf<ReturnType<(typeof IDEMPOTENCY_FAILURES)[number]>>();
  expectTypeOf<Awaited<ReturnType<typeof _call>>>().toEqualTypeOf<
    undefined | ReturnType<(typeof IDEMPOTENCY_FAILURES)[number]> | HttpClientFailure
  >();
  expectTypeOf<Failure>().not.toExtend<FailureOf<typeof _call>>();
});
