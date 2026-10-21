/**
 * `CorsOptions` is the source type and `corsSchema` checks it at boot. If either drifts,
 * an app could pass an option the schema rejects at boot, or the schema could accept a field the
 * type does not describe. This exact two-way test keeps them one shape.
 */
import type { z } from 'zod';
import { expectTypeOf, test } from 'vitest';

import type { corsSchema } from './cors';
import type { CorsOptions } from './request-context';

test('corsSchema parses to exactly CorsOptions', () => {
  expectTypeOf<z.output<typeof corsSchema>>().toEqualTypeOf<CorsOptions>();
});
