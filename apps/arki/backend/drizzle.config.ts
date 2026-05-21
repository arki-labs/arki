import { type Config } from 'drizzle-kit';

import { env } from './src/env';
import { APP_KEY } from './src/info';

export default {
  schema: './src/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: env.DB_URL,
  },
  schemaFilter: APP_KEY,
  migrations: {
    table: '_migrations',
    schema: APP_KEY,
  },
  out: './migrations',
  verbose: true,
} satisfies Config;
