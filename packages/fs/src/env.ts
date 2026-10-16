import { defineEnv } from '@arki/env/core';

import { z } from '@arki/contracts';

export const env = defineEnv({
  name: '@arki/fs',
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

});
