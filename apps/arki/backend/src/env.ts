import { defineEnv } from '@arki/env/core';

import { foremanEnvShape } from '@arki/admin/env';
import { env as authEnv } from '@arki/auth/env';
import { z } from '@arki/contracts';
import { env as dbEnv } from '@arki/db/env';
import { env as kvEnv } from '@arki/kv/env';

export const env = defineEnv({
  name: '@arki/backend',
  extends: [authEnv, dbEnv, kvEnv],
  server: {
    FOREMAN_TOKEN: z.string().min(1).optional(),
    /** The deployed commit, reported in Foreman's manifest. Coolify sets it. */
    SOURCE_COMMIT: z.string().min(1).optional(),
    ...foremanEnvShape,
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    VITE_URL: z
      .url()
      .default(() =>
        process.env['NODE_ENV'] === 'production' ? 'https://arki.com' : 'http://localhost:5181',
      ),
    PRODUCTION_URL: z.url().default('https://arki.com').optional(),
  },
});
