import { describe, expect, it } from 'vitest';

import { foremanEnvironmentFromNodeEnv } from './env.ts';
import { audienceSchema, foremanEnvironmentSchema } from './protocol.ts';

/** A process env with no NODE_ENV in it. */
const emptyProcessEnv: NodeJS.ProcessEnv = {};

describe('T(admin-env) one environment vocabulary: prod, staging, dev', () => {
  it('maps NODE_ENV production to prod and everything else to dev', () => {
    expect(foremanEnvironmentFromNodeEnv('production')).toBe('prod');
    expect(foremanEnvironmentFromNodeEnv('development')).toBe('dev');
    expect(foremanEnvironmentFromNodeEnv('test')).toBe('dev');
    expect(foremanEnvironmentFromNodeEnv(emptyProcessEnv.NODE_ENV)).toBe('dev');
  });

  it('lets FOREMAN_ENVIRONMENT override, so a staging build of NODE_ENV=production is staging', () => {
    expect(foremanEnvironmentFromNodeEnv('production', 'staging')).toBe('staging');
  });

  it('refuses the old names, so an app cannot claim an audience Foreman never targets', () => {
    expect(foremanEnvironmentSchema.safeParse('production').success).toBe(false);
    expect(audienceSchema.safeParse('novelette:production').success).toBe(false);
    expect(audienceSchema.safeParse('novelette:development').success).toBe(false);
    expect(audienceSchema.safeParse('novelette:prod').success).toBe(true);
  });
});
