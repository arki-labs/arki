import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import type { Duration, Grant, Guarantees, Key, SemaphoreConfig } from './types.js';
import { durationSchema, grantSchema, guaranteesSchema, keySchema, semaphoreConfigSchema } from './zod.js';

describe('public types and canonical schemas agree in both directions', () => {
  it('preserves each source shape without exposing Zod from ordinary declarations', () => {
    expectTypeOf<z.output<typeof durationSchema>>().toEqualTypeOf<Duration>();
    expectTypeOf<z.output<typeof grantSchema>>().toEqualTypeOf<Grant>();
    expectTypeOf<z.output<typeof guaranteesSchema>>().toEqualTypeOf<Guarantees>();
    expectTypeOf<z.output<typeof keySchema>>().toEqualTypeOf<Key>();
    expectTypeOf<z.output<typeof semaphoreConfigSchema>>().toEqualTypeOf<SemaphoreConfig>();
  });
});
