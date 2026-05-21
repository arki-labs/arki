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

import { defineApp } from '@arki/dot/plugin';
import { describe, expect, it } from 'vitest';

import { KV } from './index.js';
import { kv } from './dot.js';

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

  it('throws a clear error when no URL is configured', async () => {
    const previous = process.env['KV_URL'];
    delete process.env['KV_URL'];
    try {
      await expect(
        defineApp('kv-missing-url').use(kv()).boot(),
      ).rejects.toThrow(/KV URL is not configured/);
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

  it('honors a custom plugin name', () => {
    const configured = defineApp('kv-named-test')
      .use(
        kv({
          name: 'cache',
          url: 'redis://localhost:6379',
        }),
      )
      .configure();
    expect(configured.manifest.plugins.map(p => p.name)).toEqual(['cache']);
    expect(configured.manifest.services).toEqual([
      { name: 'kv', plugin: 'cache', kind: 'kv' },
    ]);
  });
});
