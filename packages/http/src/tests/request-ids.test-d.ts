import { expectTypeOf } from 'vitest';

import type { ID_GENERATION_FAILURES, IdGenerationFailure, IdOf, z } from '@arki/contracts';
import type { FailureOf } from '@arki/failure';

import type { HttpClientFailure } from '../client.js';
import type { requestContext } from '../context.js';
import type { BaseRequestCtx } from '../derive.js';
import type { HTTP_SERVER_FAILURES } from '../failures.js';
import type { IdempotencyOwnerId, RequestId } from '../ids.js';
import { routes } from '../bundle.js';
import { createClient } from '../client.js';
import { route } from '../contract.js';
import { idempotencyOwnerId, requestId } from '../ids.js';

expectTypeOf<RequestId>().toEqualTypeOf<IdOf<typeof requestId>>();
expectTypeOf<RequestId>().toEqualTypeOf<z.output<typeof requestId.schema>>();
expectTypeOf<IdempotencyOwnerId>().toEqualTypeOf<IdOf<typeof idempotencyOwnerId>>();
expectTypeOf(requestId.create).returns.toEqualTypeOf<RequestId | IdGenerationFailure>();
expectTypeOf(idempotencyOwnerId.create).returns.toEqualTypeOf<IdempotencyOwnerId | IdGenerationFailure>();
expectTypeOf<string>().not.toExtend<RequestId>();
expectTypeOf<string>().not.toExtend<IdempotencyOwnerId>();
expectTypeOf<RequestId>().not.toExtend<IdempotencyOwnerId>();
expectTypeOf<IdempotencyOwnerId>().not.toExtend<RequestId>();
expectTypeOf<BaseRequestCtx['requestId']>().toEqualTypeOf<RequestId>();
expectTypeOf<NonNullable<ReturnType<typeof requestContext>>['requestId']>().toEqualTypeOf<RequestId>();
expectTypeOf<FailureOf<(typeof HTTP_SERVER_FAILURES)[number]>>().toEqualTypeOf<IdGenerationFailure>();
expectTypeOf<FailureOf<(typeof ID_GENERATION_FAILURES)[number]>>().toEqualTypeOf<
  Extract<HttpClientFailure, IdGenerationFailure>
>();

const endpoint = route.get('/request', { id: 'request', output: requestId.schema });
routes().bind(endpoint, (_input, ctx) => {
  expectTypeOf(ctx.requestId).toEqualTypeOf<RequestId>();
  return ctx.requestId;
});
const call = createClient(endpoint, { baseUrl: 'http://test' });
expectTypeOf(call).returns.resolves.toEqualTypeOf<RequestId | HttpClientFailure>();
