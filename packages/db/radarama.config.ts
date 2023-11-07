import type { Config } from 'drizzle-kit';

import { env } from './env.mjs';
import { TABLE_PREFIX } from './radarama/schema/_table';

export default {
  schema: './radarama/schema',
  driver: 'pg',
  dbCredentials: {
    connectionString: env['POSTGRES_URL'] + '?sslmode=require',
  },
  tablesFilter: [`${TABLE_PREFIX}*`],
  out: './radarama/migrations',
} satisfies Config;
