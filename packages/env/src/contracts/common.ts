import { z } from 'zod';

export const commonContracts = {
  string: (defaultValue?: string) => {
    const schema = z.string();
    return defaultValue ? schema.default(defaultValue) : schema;
  },

  number: (defaultValue?: number) => {
    const schema = z.coerce.number();
    return defaultValue ? schema.default(defaultValue) : schema;
  },

  port: (defaultValue = 3000) =>
    z
      .coerce.number()
      .min(1, 'Port must be at least 1')
      .max(65_535, 'Port must be at most 65535')
      .default(defaultValue),

  nodeEnv: () => z.enum(['development', 'production', 'test']).default('development'),

  boolean: (defaultValue = false) =>
    z
      .enum(['true', 'false', '1', '0'])
      .default(defaultValue ? 'true' : 'false')
      .transform(val => val === 'true' || val === '1'),

  logLevel: (defaultValue: 'debug' | 'info' | 'warn' | 'error' = 'info') =>
    z.enum(['debug', 'info', 'warn', 'error']).default(defaultValue),
};
