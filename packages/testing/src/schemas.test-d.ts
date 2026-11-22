/** Locks the internal schemas to the public TS types: a field added to one side only, or a widened union, fails typecheck. */
import type { z } from 'zod';
import { expectTypeOf } from 'vitest';

import type { CheckedClaim, Verdict } from './ai/answers.js';
import type { checkedClaimSchema, verdictSchema } from './ai/schemas.js';
import type { PaginatedResponse } from './assertions.js';
import type { paginatedResponseSchema, timestampSchema } from './schemas.js';
import type { Timestamp } from './timestamps.js';

expectTypeOf<z.output<typeof timestampSchema>>().toEqualTypeOf<Timestamp>();
expectTypeOf<z.output<typeof paginatedResponseSchema>>().toEqualTypeOf<PaginatedResponse>();
expectTypeOf<z.output<typeof verdictSchema>>().toEqualTypeOf<Verdict>();
expectTypeOf<z.output<typeof checkedClaimSchema>>().toEqualTypeOf<CheckedClaim>();
