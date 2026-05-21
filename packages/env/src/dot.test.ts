/**
 * Tests for the env DOT adapter.
 *
 * Verifies the adapter:
 *   - registers exactly one `env`-kind service in the manifest
 *   - publishes a typed env object into `app.services.env`
 *   - boots/disposes through the standard DOT lifecycle
 */

import { defineApp } from '@arki/dot/plugin';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { env } from './dot.js';

describe('@arki/env/dot', () => {
  it('boots and exposes the validated env service', async () => {
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
      expect(app.manifest.services).toEqual([
        { name: 'env', plugin: 'env', kind: 'env' },
      ]);
      expect(app.manifest.plugins.map(p => p.name)).toEqual(['env']);
    } finally {
      await app.dispose();
    }
  });

  it('honors a custom plugin name', async () => {
    const app = await defineApp('env-named-test')
      .use(
        env({
          name: 'public-env',
          schema: { FLAG: z.string().default('on') },
          skipValidation: true,
        }),
      )
      .boot();
    try {
      expect(app.manifest.plugins.map(p => p.name)).toEqual(['public-env']);
      expect(app.manifest.services).toEqual([
        { name: 'env', plugin: 'public-env', kind: 'env' },
      ]);
    } finally {
      await app.dispose();
    }
  });
});
