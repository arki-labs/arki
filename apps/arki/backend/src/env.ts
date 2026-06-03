import { createEnv } from '@t3-oss/env-core';

import { env as authEnv } from '@arki/auth/env';
import { z } from '@arki/contracts';
import { env as dbEnv } from '@arki/db/env';
import { env as kvEnv } from '@arki/kv/env';

export const env = createEnv({
  extends: [authEnv, dbEnv, kvEnv],
  server: {
    NODE_ENV: z.enum(['development', 'production']).default('development'),
    VITE_URL: z
      .url()
      .default(() =>
        process.env['NODE_ENV'] === 'production' ? 'https://arki.com' : 'http://localhost:5181',
      ),
    PRODUCTION_URL: z.url().default('https://arki.com').optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env['CI'] || process.env['npm_lifecycle_event'] === 'lint',
});
