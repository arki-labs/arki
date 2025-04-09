import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export const env = createEnv({
  server: {
    KV_URL: z.string().url(),
    DB_URL: z.string().url(),
    NODE_ENV: z.string().default('development'),
    AUTH_SECRET: process.env.NODE_ENV === 'production' ? z.string().min(1) : z.string().min(1).optional(),
    RESEND_API_KEY: z.string(),
    EMAIL_FROM: z.string().email().default('noreply@furculita.net'),
    AUTH_DEBUG: z
      .string()
      .transform(val => val === 'true')
      .default(String(process.env.NODE_ENV !== 'production')),
    TMDB_API_KEY: z.string().min(1).optional(),
  },
  client: {},
  experimental__runtimeEnv: {
    KV_URL: process.env['KV_URL'],
    DB_URL: process.env['DB_URL'],
    NODE_ENV: process.env.NODE_ENV,
  },
  skipValidation: !!process.env['CI'] || process.env['npm_lifecycle_event'] === 'lint',
});
