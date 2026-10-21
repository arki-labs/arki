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

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { Provided } from '@arki/dot/unit';
import { defineApp, DotUnitError, rename } from '@arki/dot/unit';
import { orThrow, UnexpectedDefect } from '@arki/failure';

import type * as KvModule from './index.js';
import { kv, KV_PLUGIN_ERROR_CODES } from './dot.js';
import { KV } from './index.js';

// Count every client the adapter constructs: "optional" must mean that no
// client (and so no Redis socket) exists when no URL is configured.
const constructed = vi.hoisted(() => ({ count: 0 }));
vi.mock('./index.js', async importOriginal => {
  const actual = await importOriginal<typeof KvModule>();
  class CountingKV extends actual.KV {
    constructor(...args: ConstructorParameters<typeof actual.KV>) {
      super(...args);
      constructed.count += 1;
    }
  }
  return { ...actual, KV: CountingKV };
});

/** Run `body` with `KV_URL` unset, restoring it afterwards. */
async function withoutKvUrl(body: () => Promise<void>): Promise<void> {
  const previous = process.env['KV_URL'];
  delete process.env['KV_URL'];
  try {
    await body();
  } finally {
    if (previous !== undefined) process.env['KV_URL'] = previous;
  }
}

describe('@arki/kv/dot', () => {
  it('contributes a kv-kind service to the manifest', () => {
    const builder = defineApp('kv-manifest-test').infra(
      kv({ url: 'redis://localhost:6379', namespace: 'manifest-test' }),
    );
    const configured = orThrow(builder.configure());
    expect(configured.manifest.services).toEqual([{ name: 'kv', plugin: 'kv', kind: 'kv' }]);
    expect(configured.manifest.plugins.map(p => p.name)).toEqual(['kv']);
  });

  it('returns a defect preserving the coded DotUnitError when no URL is configured', async () => {
    // Legacy plugin throws return a defect with the original coded cause.
    const previous = process.env['KV_URL'];
    delete process.env['KV_URL'];
    try {
      const caught = await defineApp('kv-missing-url').infra(kv()).boot();
      if (!UnexpectedDefect.is(caught)) throw new Error('boot should return UnexpectedDefect');
      const cause = caught.cause;
      expect(cause).toBeInstanceOf(DotUnitError);
      if (!(cause instanceof DotUnitError)) throw new Error('cause should be a DotUnitError');
      const pluginErr = cause;
      expect(pluginErr.code).toBe(KV_PLUGIN_ERROR_CODES.urlNotConfigured);
      expect(pluginErr.code).toBe('ARKI_KV_PLUGIN_E001');
      expect(pluginErr.message).toMatch(/KV URL is not configured/);
      expect(pluginErr.remediation).toMatch(/options\.url|KV_URL/);
      expect(pluginErr.docsUrl).toMatch(/^https?:\/\//);
    } finally {
      if (previous !== undefined) process.env['KV_URL'] = previous;
    }
  });

  it('boots and exposes a KV instance, then disposes', async () => {
    const app = await orThrow(
      defineApp('kv-lifecycle-test')
        .infra(
          kv({
            url: 'redis://127.0.0.1:1', // unreachable but well-formed URL
            namespace: 'lifecycle-test',
          }),
        )
        .boot(),
    );
    try {
      expect(app.services.kv).toBeInstanceOf(KV);
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('mounts a second KV scope via rename()', async () => {
    const app = await orThrow(
      defineApp('kv-named-test')
        .infra(kv({ url: 'redis://127.0.0.1:1', namespace: 'app' }))
        .infra(rename(kv({ url: 'redis://127.0.0.1:1', namespace: 'sessions' }), { kv: 'sessionsKv' }, 'sessions-kv'))
        .boot(),
    );
    try {
      expect(app.manifest.plugins.map(p => p.name)).toEqual(['kv', 'sessions-kv']);
      expect(app.services.kv).toBeInstanceOf(KV);
      expect(app.services.sessionsKv).toBeInstanceOf(KV);
      expect(app.services.kv).not.toBe(app.services.sessionsKv);
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('probe: true fails boot with a coded error when Redis is unreachable', async () => {
    // A bad URL must stop the app at boot, not at the first request.
    const caught = await defineApp('kv-probe-fails')
      .infra(kv({ url: 'redis://127.0.0.1:1', probe: true, probeTimeoutMs: 300 }))
      .boot();
    if (!UnexpectedDefect.is(caught)) throw new Error('boot should return UnexpectedDefect');
    const cause = caught.cause;
    expect(cause).toBeInstanceOf(DotUnitError);
    if (!(cause instanceof DotUnitError)) throw new Error('cause should be a DotUnitError');
    expect(cause.code).toBe(KV_PLUGIN_ERROR_CODES.probeFailed);
  });
});

describe('@arki/kv/dot kv.optional', () => {
  beforeEach(() => {
    constructed.count = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('types the published value as KV | null, so consumers must handle null', () => {
    type Optional = ReturnType<typeof kv.optional>;
    expectTypeOf<Provided<Optional['provides']['kv']>>().toEqualTypeOf<KV | null>();
  });

  it('publishes null and opens no client when no URL is configured', async () => {
    // Dev and tests run without Redis: boot must succeed and nothing may connect.
    await withoutKvUrl(async () => {
      const app = await orThrow(defineApp('kv-optional-null').infra(kv.optional()).boot());
      try {
        expect(app.services.kv).toBeNull();
        expect(constructed.count).toBe(0);
      } finally {
        await orThrow(app.dispose());
      }
    });
  });

  it('treats an empty URL (an empty env var) as unset', async () => {
    const app = await orThrow(
      defineApp('kv-optional-empty')
        .infra(kv.optional(() => ({ url: '' })))
        .boot(),
    );
    try {
      expect(app.services.kv).toBeNull();
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('opens the same client kv() opens when a URL is configured, and closes it on dispose', async () => {
    const close = vi.spyOn(KV.prototype, 'close');
    const app = await orThrow(
      defineApp('kv-optional-url')
        .infra(kv.optional({ url: 'redis://127.0.0.1:1', namespace: 'optional-test' }))
        .boot(),
    );
    expect(app.services.kv).toBeInstanceOf(KV);
    expect(constructed.count).toBe(1);
    await orThrow(app.dispose());
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('probe: true still fails boot on a bad URL — optional means "no URL", not "ignore errors"', async () => {
    const caught = await defineApp('kv-optional-probe-fails')
      .infra(kv.optional({ url: 'redis://127.0.0.1:1', probe: true, probeTimeoutMs: 300 }))
      .boot();
    if (!UnexpectedDefect.is(caught)) throw new Error('boot should return UnexpectedDefect');
    if (!(caught.cause instanceof DotUnitError)) throw new Error('cause should be a DotUnitError');
    expect(caught.cause.code).toBe(KV_PLUGIN_ERROR_CODES.probeFailed);
  });

  // Needs a real Redis: `KV_TEST_URL=redis://127.0.0.1:6379 bun run test`.
  it.runIf(process.env['KV_TEST_URL'])('passes the probe and round-trips a value against a real Redis', async () => {
    const app = await orThrow(
      defineApp('kv-optional-real')
        .infra(kv.optional({ url: process.env['KV_TEST_URL'], namespace: 'arki-kv-dot-test', probe: true }))
        .boot(),
    );
    try {
      const client = app.services.kv;
      expect(client).toBeInstanceOf(KV);
      await client?.set('greeting', 'hello', 5);
      expect(await client?.get('greeting')).toBe('hello');
      await client?.delete('greeting');
    } finally {
      await orThrow(app.dispose());
    }
  });
});
