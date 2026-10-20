import type { z } from 'zod';
import { expectTypeOf, it } from 'vitest';

import type { FailureOf, UnexpectedDefect } from '@arki/failure';

import type { RandomSourceUnavailable } from './errors.js';
import type { ID_GENERATION_FAILURES, IdDeclaration, IdGenerationFailure, IdOf } from './ids.js';
import { defineId } from './ids.js';

it('ID generation exposes exact canonical failures while schema and IdOf remain success-only', () => {
  const storyId = defineId('sty_');
  expectTypeOf<IdDeclaration<'sty_'>>().toEqualTypeOf<typeof storyId>();
  expectTypeOf(storyId).toEqualTypeOf<Readonly<typeof storyId>>();
  expectTypeOf<IdOf<typeof storyId>>().toEqualTypeOf<`sty_${string}`>();
  expectTypeOf<z.output<typeof storyId.schema>>().toEqualTypeOf<IdOf<typeof storyId>>();
  expectTypeOf<ReturnType<typeof storyId.create>>().toEqualTypeOf<`sty_${string}` | IdGenerationFailure>();
  expectTypeOf<IdGenerationFailure>().toEqualTypeOf<FailureOf<(typeof ID_GENERATION_FAILURES)[number]>>();
  expectTypeOf<FailureOf<typeof storyId.create>>().toEqualTypeOf<
    FailureOf<typeof RandomSourceUnavailable> | FailureOf<typeof UnexpectedDefect>
  >();
});
