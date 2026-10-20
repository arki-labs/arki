import { expectTypeOf, it } from 'vitest';

import type { Failure } from '@arki/failure';
import { defineFailure } from '@arki/failure';

import type { RouteFailure } from '../contract.js';
import type { HttpClientFailure } from '../failures.js';
import type { IdempotencyHashUnavailable, IdempotencyRequestUnreadable, ResponseCache } from '../idempotency.js';
import { createClient } from '../client.js';
import { route } from '../contract.js';
import { IDEMPOTENCY_FAILURES, idempotent } from '../idempotency.js';

const Denied = defineFailure('test.scope_denied', { status: 403 });
const Limited = defineFailure('test.scope_limited', { status: 429 });
const cache: ResponseCache = {
  begin: () => Promise.resolve('started'),
  finish: () => Promise.resolve(),
  abandon: () => Promise.resolve(),
};
it('admits inferred canonical scope failures only when every route declares them', () => {
  const complete = route.post('/complete', { id: 'complete', failures: [...IDEMPOTENCY_FAILURES, Denied, Limited] });
  const missing = route.post('/missing', { id: 'missing', failures: IDEMPOTENCY_FAILURES });
  const partial = route.post('/partial', { id: 'partial', failures: [...IDEMPOTENCY_FAILURES, Denied] });
  const scope = (req: Request) =>
    Promise.resolve(req.headers.has('user') ? 'user' : req.headers.has('limited') ? Limited() : Denied());
  idempotent({ cache, scope, routes: [complete], ttl: 100 });
  idempotent({
    cache,
    scope: (): undefined => {
      /* Unauthenticated requests deliberately bypass replay. */
    },
    routes: [missing],
    ttl: 100,
  });
  idempotent({ cache, scope: () => 'user', routes: [missing], ttl: 100 });
  // @ts-expect-error Every inferred scope failure must be admitted.
  idempotent({ cache, scope, routes: [missing], ttl: 100 });
  // @ts-expect-error A partial scope failure declaration is insufficient.
  idempotent({ cache, scope, routes: [partial], ttl: 100 });
  // @ts-expect-error A complete first route cannot cover a second route's omissions.
  idempotent({ cache, scope, routes: [complete, partial], ttl: 100 });
  const widened = (): Failure => Denied();
  // @ts-expect-error A generic Failure does not prove which failures a route must admit.
  idempotent({ cache, scope: widened, routes: [complete], ttl: 100 });
  const _call = createClient(complete, { baseUrl: 'https://test' });
  expectTypeOf<Awaited<ReturnType<typeof _call>>>().toEqualTypeOf<
    undefined | RouteFailure<typeof complete> | HttpClientFailure
  >();
  expectTypeOf<RouteFailure<typeof complete>>().toEqualTypeOf<
    ReturnType<(typeof IDEMPOTENCY_FAILURES)[number]> | ReturnType<typeof Denied> | ReturnType<typeof Limited>
  >();
  expectTypeOf<
    ReturnType<typeof IdempotencyRequestUnreadable>['code']
  >().toEqualTypeOf<'http.idempotency_request_unreadable'>();
  expectTypeOf<
    ReturnType<typeof IdempotencyHashUnavailable>['code']
  >().toEqualTypeOf<'http.idempotency_hash_unavailable'>();
});
