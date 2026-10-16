/**
 * Tests for the env DOT adapter.
 *
 * Verifies the adapter:
 *   - registers exactly one `env`-kind service in the manifest
 *   - publishes a typed env object into `app.services.env`
 *   - boots/disposes through the standard DOT lifecycle
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import { runExplain } from '@arki/dot/cli';
import { defineApp, DotLifecycleError, DotLifecycleErrorCode, DotPluginError, rename } from '@arki/dot/plugin';

import type { EnvServices } from './dot.js';
import { ENV_PLUGIN_ERROR_CODES, env } from './dot.js';

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

describe('@arki/env/dot validation at boot', () => {
  const schema = { ENV_PLUGIN_T1_A: z.string(), ENV_PLUGIN_T1_B: z.url() };

  beforeEach(() => {
    vi.stubEnv('SKIP_ENV_VALIDATION', '');
    vi.stubEnv('CI', 'true');
    vi.spyOn(console, 'error').mockImplementation(vi.fn());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('fails boot with the bad keys named, even when CI is set', async () => {
    // WHY: a bad config must stop the app at boot, never at the first request.
    const app = defineApp('env-bad').use(env({ schema }));
    const error: unknown = await app.boot().catch((error_: unknown) => error_);
    if (!(error instanceof DotLifecycleError)) throw new Error('boot should reject with DotLifecycleError');
    expect(error.code).toBe(DotLifecycleErrorCode.BootFailed);
    const cause = error.cause;
    if (!(cause instanceof DotPluginError)) throw new Error('cause should be a DotPluginError');
    expect(cause.code).toBe(ENV_PLUGIN_ERROR_CODES.invalidEnv);
    expect(cause.message).toContain('ENV_PLUGIN_T1_A');
    expect(cause.message).toContain('ENV_PLUGIN_T1_B');
  });

  it('the env factory throws synchronously, so boot never depends on awaiting the proxy', () => {
    // WHY: validation was once an accident of `await` reading `.then` on the proxy. Calling the
    // factory without awaiting proves the plugin itself forces validation.
    const plugin = env({ schema });
    const factory = plugin.factories['env'];
    if (factory === undefined) throw new Error('env plugin has no env factory');
    expect(() => Reflect.apply(factory, undefined, [])).toThrow('ENV_PLUGIN_T1_A');
  });

  it('skipValidation: true boots with missing keys', async () => {
    // WHY: the explicit opt-out must reach the plugin.
    const app = await defineApp('env-skip').use(env({ schema, skipValidation: true })).boot();
    await app.dispose();
  });

  it('SKIP_ENV_VALIDATION=1 boots with missing keys', async () => {
    // WHY: Docker build stages that prerender without secrets rely on this opt-out.
    vi.stubEnv('SKIP_ENV_VALIDATION', '1');
    const app = await defineApp('env-skip-var').use(env({ schema })).boot();
    await app.dispose();
  });

  it('`dot explain` configures an app whose env has a missing required key', async () => {
    // WHY: explain needs no secrets. This fails if validation moves into `configure`.
    const builder = defineApp('env-explain').use(env({ schema }));
    const envelope = await runExplain(builder, { json: true, out: vi.fn() });
    expect(envelope.status).toBe('success');
    expect(JSON.stringify(envelope.data)).toContain('"env"');
  });

  it('exposes the typed keys on EnvServices', () => {
    // WHY: the service type is derived from defineEnv, so inference must keep flowing to users.
    type Services = EnvServices<{ PORT: z.ZodDefault<z.ZodCoercedNumber>; NAME: z.ZodString }>;
    expectTypeOf<Services['env']['PORT']>().toEqualTypeOf<number>();
    expectTypeOf<Services['env']['NAME']>().toEqualTypeOf<string>();
  });
});
