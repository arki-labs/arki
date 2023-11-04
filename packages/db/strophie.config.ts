import type { Config } from 'drizzle-kit';

import { env } from './env.mjs';
import { TABLE_PREFIX } from './strophie/schema/_table';

export default {
  schema: './strophie/schema',
  driver: 'pg',
  dbCredentials: {
    connectionString: env['POSTGRES_URL'] + '?sslmode=require',
  },
  tablesFilter: [`${TABLE_PREFIX}*`],
  out: './strophie/migrations',
} satisfies Config;
