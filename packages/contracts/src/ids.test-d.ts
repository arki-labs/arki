import { z } from 'zod';
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

it('IdOf reads schema output so transforms and brands cannot be erased by a prefix', () => {
  const _domain = { schema: z.string().brand<'RefundId'>() };
  expectTypeOf<IdOf<typeof _domain>>().toEqualTypeOf<z.output<typeof _domain.schema>>();
  expectTypeOf<IdOf<typeof _domain>>().not.toEqualTypeOf<string>();
  const _transformed = { schema: z.string().transform(value => value.length) };
  expectTypeOf<IdOf<typeof _transformed>>().toEqualTypeOf<number>();
  // @ts-expect-error A prefix without a canonical schema cannot establish a domain type.
  type _Unvalidated = IdOf<{ prefix: 'refund_' }>;
});
