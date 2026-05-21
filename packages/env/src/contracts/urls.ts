import { z } from 'zod';

export const urlContracts = {
  url: (defaultValue?: string) => {
    const schema = z.string().url();
    return defaultValue ? schema.default(defaultValue) : schema;
  },

  databaseUrl: () =>
    z
      .url()
      .refine(
        url => url.startsWith('postgres://') || url.startsWith('postgresql://'),
        'Database URL must start with postgres:// or postgresql://',
      ),

  redisUrl: () =>
    z
      .url()
      .refine(url => url.startsWith('redis://') || url.startsWith('rediss://'), 'Redis URL must start with redis:// or rediss://'),
};
