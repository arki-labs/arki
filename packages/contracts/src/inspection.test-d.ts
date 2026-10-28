import type { z } from 'zod';
import { expectTypeOf, it } from 'vitest';

import type { nativeSchema, operationSchema } from './inspection.js';
import type { AnyOperation } from './orpc.js';

it('locks native inspection to its public source types without widening', () => {
  // Public types remain the source; native inspection must not erase or widen them.
  expectTypeOf<z.output<typeof operationSchema>>().toEqualTypeOf<AnyOperation>();
  expectTypeOf<z.input<typeof operationSchema>>().toEqualTypeOf<AnyOperation>();
  expectTypeOf<z.output<typeof nativeSchema>>().toEqualTypeOf<z.ZodType>();
});
