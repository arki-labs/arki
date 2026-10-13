/**
 * Tests for the env DOT adapter.
 *
 * Verifies the adapter:
 *   - registers exactly one `env`-kind service in the manifest
 *   - publishes a typed env object into `app.services.env`
 *   - boots/disposes through the standard DOT lifecycle
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineApp, rename } from '@arki/dot/plugin';

import { env } from './dot.js';

describe('@arki/env/dot', () => {
  it('boots and exposes the validated env service', async () => {
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- test-only variable, set and removed by this test
    process.env['ADAPTER_TEST_PORT'] = '4242';
    const app = await defineApp('env-test')
      .use(
        env({
          schema: {
            ADAPTER_TEST_PORT: z.coerce.number(),
          },
          skipValidation: false,
        }),
      )
      .boot();
    try {
      expect(app.services.env.ADAPTER_TEST_PORT).toBe(4242);
    } finally {
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- test-only variable, set and removed by this test
      delete process.env['ADAPTER_TEST_PORT'];
      await app.dispose();
    }
  });

  it('contributes a service manifest entry of kind=env', async () => {
    const app = await defineApp('env-manifest-test')
      .use(
        env({
          schema: {
            DUMMY: z.string().default('x'),
          },
          skipValidation: true,
        }),
      )
      .boot();
    try {
      expect(app.manifest.services).toEqual([{ name: 'env', plugin: 'env', kind: 'env' }]);
      expect(app.manifest.plugins.map(p => p.name)).toEqual(['env']);
    } finally {
      await app.dispose();
    }
  });

  it('mounts a second env scope via rename()', async () => {
    const app = await defineApp('env-named-test')
      .use(
        env({
          schema: { FLAG: z.string().default('on') },
          skipValidation: false,
        }),
      )
      .use(
        rename(
          env({
            schema: { PUBLIC_FLAG: z.string().default('off') },
            skipValidation: false,
          }),
          { env: 'publicEnv' },
          'public-env',
        ),
      )
      .boot();
    try {
      expect(app.manifest.plugins.map(p => p.name)).toEqual(['env', 'public-env']);
      expect(app.services.env.FLAG).toBe('on');
      expect(app.services.publicEnv.PUBLIC_FLAG).toBe('off');
    } finally {
      await app.dispose();
    }
  });
});
