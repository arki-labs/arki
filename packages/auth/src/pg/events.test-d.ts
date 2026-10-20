import { expectTypeOf } from 'vitest';

import type { IdGenerationFailure, IdOf, z } from '@arki/contracts';

import type { authRequestId } from '../id-declarations.js';
import type { AuthRequestId, SessionId } from '../ids.js';
import type { authRequestIdSchema } from '../zod.js';
import type { AuthEvents } from './types.js';
import { requestIdOf } from './events.js';

expectTypeOf<AuthRequestId>().toEqualTypeOf<IdOf<typeof authRequestId>>();
expectTypeOf(requestIdOf).returns.toEqualTypeOf<AuthRequestId | IdGenerationFailure>();
expectTypeOf<
  Parameters<NonNullable<AuthEvents<unknown, unknown>['signIn']>>[0]['requestId']
>().toEqualTypeOf<AuthRequestId>();
expectTypeOf<string>().not.toExtend<AuthRequestId>();
expectTypeOf<SessionId>().not.toExtend<AuthRequestId>();

expectTypeOf<z.output<typeof authRequestIdSchema>>().toEqualTypeOf<AuthRequestId>();
