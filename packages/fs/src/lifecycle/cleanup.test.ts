import type { z } from 'zod';
import { expectTypeOf, it } from 'vitest';

import type { cleanupOptions } from '../files/schemas.js';
import type { CleanupOptions } from './cleanup.js';

it('locks the public cleanup options to the canonical parser in both directions', () => {
  expectTypeOf<z.input<typeof cleanupOptions>>().toEqualTypeOf<CleanupOptions>();
});
