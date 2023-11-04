import * as dotenv from 'dotenv';
import type { Config } from 'drizzle-kit';

import { TABLE_PREFIX } from './strophie/schema/_table';

dotenv.config({
  path: '../../.env',
  debug: true,
});

if (!process.env['DATABASE_URL']) {
  throw new Error('DATABASE_URL is not set');
}

export default {
  schema: './strophie/schema',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env['DATABASE_URL'] + '?sslmode=require',
  },
  tablesFilter: [`${TABLE_PREFIX}*`],
  out: './strophie/migrations',
} satisfies Config;
