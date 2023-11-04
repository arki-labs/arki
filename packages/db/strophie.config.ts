import * as dotenv from 'dotenv';
import type { Config } from 'drizzle-kit';

import { TABLE_PREFIX } from './strophie/schema/_table';

dotenv.config({
  path: '../../.env',
  debug: true,
});

if (!process.env['POSTGRES_URL']) {
  throw new Error('POSTGRES_URL is not set');
}

export default {
  schema: './strophie/schema',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env['POSTGRES_URL'] + '?sslmode=require',
  },
  tablesFilter: [`${TABLE_PREFIX}*`],
  out: './strophie/migrations',
} satisfies Config;
