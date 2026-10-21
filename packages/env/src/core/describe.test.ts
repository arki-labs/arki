/**
 * `dot env check` relies on `describeEnv` to know which keys must never be plaintext in a tracked
 * file, across composed envs, without reading a single value.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineEnv } from './define-env.js';
import { describeEnv } from './describe.js';
import { secret } from './secret.js';

describe('describeEnv', () => {
  it('lists declared keys, secrets included, through extends, without reading the environment', () => {
    const base = defineEnv({ name: 'base', server: { DB_URL: secret(z.string()) } });
    const app = defineEnv({
      name: 'app',
      extends: [base],
      server: { PORT: z.coerce.number(), TOKEN: secret(z.string()).optional() },
      clientPrefix: 'VITE_',
      client: { VITE_URL: z.string() },
    });
    expect(describeEnv(app)).toEqual({
      name: 'app',
      keys: [
        { key: 'DB_URL', secret: true, scope: 'server' },
        { key: 'VITE_URL', secret: false, scope: 'client' },
        { key: 'PORT', secret: false, scope: 'server' },
        { key: 'TOKEN', secret: true, scope: 'server' },
      ],
    });
  });

  it('knows nothing about other objects', () => {
    expect(describeEnv({})).toBeUndefined();
  });
});
