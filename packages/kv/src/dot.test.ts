/**
 * Tests for the kv DOT adapter.
 *
 * Verifies the adapter:
 *   - registers exactly one `kv`-kind service in the manifest
 *   - throws a clear error when no URL is configured
 *   - boots, exposes the KV client, and disposes cleanly when given a URL
 *
 * The boot tests use a fake Redis URL — `KV.close()` is best-effort and
 * tolerates the underlying connection never having opened. We never call
 * `kv.get/set` in tests because that would require a real Redis instance.
 */

import { defineApp, DotLifecycleError, DotPluginError, rename } from '@arki/dot/plugin';
import { describe, expect, it } from 'vitest';

import { KV } from './index.js';
import { kv, KV_PLUGIN_ERROR_CODES } from './dot.js';

describe('@arki/kv/dot', () => {
  it('contributes a kv-kind service to the manifest', () => {
    const builder = defineApp('kv-manifest-test').use(
      kv({ url: 'redis://localhost:6379', namespace: 'manifest-test' }),
    );
    const configured = builder.configure();
    expect(configured.manifest.services).toEqual([
      { name: 'kv', plugin: 'kv', kind: 'kv' },
    ]);
    expect(configured.manifest.plugins.map(p => p.name)).toEqual(['kv']);
  });

  it('throws a coded DotPluginError when no URL is configured', async () => {
    // The kernel wraps any throw from a boot hook in DotLifecycleError so
    // every boot failure has a uniform outer shape. The original throw is
    // preserved on `.cause` — that's what consumers and coding agents
    // match against for the stable code / remediation / docsUrl.
    const previous = process.env['KV_URL'];
    delete process.env['KV_URL'];
    try {
      const caught = await defineApp('kv-missing-url')
        .use(kv())
        .boot()
        .catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(DotLifecycleError);
      const cause = (caught as DotLifecycleError).cause;
      expect(cause).toBeInstanceOf(DotPluginError);
      const pluginErr = cause as DotPluginError;
      expect(pluginErr.code).toBe(KV_PLUGIN_ERROR_CODES.urlNotConfigured);
      expect(pluginErr.code).toBe('KV_PLUGIN_E001');
      expect(pluginErr.message).toMatch(/KV URL is not configured/);
      expect(pluginErr.remediation).toMatch(/options\.url|KV_URL/);
      expect(pluginErr.docsUrl).toMatch(/^https?:\/\//);
    } finally {
      if (previous !== undefined) process.env['KV_URL'] = previous;
    }
  });

  it('boots and exposes a KV instance, then disposes', async () => {
    const app = await defineApp('kv-lifecycle-test')
      .use(
        kv({
          url: 'redis://127.0.0.1:1', // unreachable but well-formed URL
          namespace: 'lifecycle-test',
        }),
      )
      .boot();
    try {
      expect(app.services.kv).toBeInstanceOf(KV);
    } finally {
      await app.dispose();
    }
  });

  it('mounts a second KV scope via rename()', async () => {
    const app = await defineApp('kv-named-test')
      .use(kv({ url: 'redis://127.0.0.1:1', namespace: 'app' }))
      .use(rename(kv({ url: 'redis://127.0.0.1:1', namespace: 'sessions' }), { kv: 'sessionsKv' }, 'sessions-kv'))
      .boot();
    try {
      expect(app.manifest.plugins.map(p => p.name)).toEqual(['kv', 'sessions-kv']);
      expect(app.services.kv).toBeInstanceOf(KV);
      expect(app.services.sessionsKv).toBeInstanceOf(KV);
      expect(app.services.kv).not.toBe(app.services.sessionsKv);
    } finally {
      await app.dispose();
    }
  });
});
