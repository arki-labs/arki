import { createEnv } from '@t3-oss/env-core';
import { z } from '@arki/contracts';

export const env = createEnv({
  /**
   * Environment variables schema for file storage services (S3)
   */
  server: {
    // General Configuration
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // AWS S3 Configuration
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    AWS_SESSION_TOKEN: z.string().optional(),
    AWS_REGION: z.string().default('us-east-1'),
    AWS_S3_BUCKET_NAME: z.string().optional(),
    AWS_S3_PATH_PREFIX: z.string().optional(),
    AWS_ENDPOINT_URL: z.string().optional(), // For S3-compatible services like MinIO
  },

  client: {},
  clientPrefix: '',

  /**
   * Destructure all variables from `process.env` to make sure they aren't tree-shaken away.
   */
  runtimeEnv: {
    NODE_ENV: process.env['NODE_ENV'],
    AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'],
    AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'],
    AWS_SESSION_TOKEN: process.env['AWS_SESSION_TOKEN'],
    AWS_REGION: process.env['AWS_REGION'],
    AWS_S3_BUCKET_NAME: process.env['AWS_S3_BUCKET_NAME'],
    AWS_S3_PATH_PREFIX: process.env['AWS_S3_PATH_PREFIX'],
    AWS_ENDPOINT_URL: process.env['AWS_ENDPOINT_URL'],
  },

  skipValidation: !!process.env['CI'] || process.env['NODE_ENV'] !== 'development',
});
