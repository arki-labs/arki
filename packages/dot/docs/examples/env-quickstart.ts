/**
 * The smallest Dot app with a typed env: `defineApp` plus the `@arki/dot/env` adapter.
 *
 * The schema has defaults for every key, so the app boots on any laptop with no variables set.
 * `src/tests/env-quickstart-example.test.ts` boots it, so this example cannot drift.
 */
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { env } from '@arki/dot/env';

export default defineApp('my-app').use(
  env({
    schema: {
      PORT: z.coerce.number().default(3000),
      NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    },
  }),
);
