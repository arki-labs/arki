import { expectTypeOf, it } from 'vitest';

import type { IdOf } from '@arki/contracts';
import type { FailureOf } from '@arki/failure';

import type { HttpClientFailure } from '../failures.js';
import type { IDEMPOTENCY_FAILURES, IdempotencyOwnerId, idempotencyOwnerId, ResponseCache } from '../idempotency.js';
import type { RequestId } from '../ids.js';

it('infers every cache-owner argument from one canonical ID definition', () => {
  expectTypeOf<IdempotencyOwnerId>().toEqualTypeOf<IdOf<typeof idempotencyOwnerId>>();
  expectTypeOf<Parameters<ResponseCache['begin']>[2]>().toEqualTypeOf<IdempotencyOwnerId>();
  expectTypeOf<Parameters<ResponseCache['finish']>[1]>().toEqualTypeOf<IdempotencyOwnerId>();
  expectTypeOf<Parameters<ResponseCache['abandon']>[1]>().toEqualTypeOf<IdempotencyOwnerId>();
  expectTypeOf<string>().not.toExtend<IdempotencyOwnerId>();
  expectTypeOf<RequestId>().not.toExtend<IdempotencyOwnerId>();
  expectTypeOf<FailureOf<typeof idempotencyOwnerId.create>>().toExtend<
    FailureOf<(typeof IDEMPOTENCY_FAILURES)[number]>
  >();
  expectTypeOf<FailureOf<typeof idempotencyOwnerId.create>>().toExtend<HttpClientFailure>();
});
