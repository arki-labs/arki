/**
 * The env `defineEnv()` returns is lazy. Once it has been read often enough, it reads from a private
 * copy of the values (a fast path) when that copy cannot drift from the built env. These tests pin
 * that the copy and the forwarding view behave the same way, and that a caller's own `runtimeEnv`
 * stays live.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineEnv } from './define-env.js';

const server = { PORT: z.coerce.number(), NAME: z.string().default('app') };

/** Enough reads to pass the copy threshold, so the fast path (where allowed) is in use. */
const warm = (env: object): void => {
  for (let i = 0; i < 100; i++) Reflect.get(env, 'PORT');
};

describe('defineEnv()', () => {
  it('does not read or validate anything until the first access', () => {
    let reads = 0;
    const runtimeEnv = new Proxy<Record<string, string>>(
      { PORT: '1' },
      {
        get: (target, key) => {
          reads += 1;
          return Reflect.get(target, key);
        },
      },
    );
    const env = defineEnv({ server, runtimeEnv, options: { skipValidation: false } });
    expect(reads).toBe(0);
    expect(env.PORT).toBe(1);
    expect(reads).toBeGreaterThan(0);
  });

  it('retries the build after a failed validation', () => {
    const runtimeEnv: Record<string, string> = { PORT: 'not-a-number' };
    const env = defineEnv({
      server: { PORT: z.coerce.number().int() },
      runtimeEnv,
      options: {
        skipValidation: false,
        onValidationError: () => {
          throw new Error('invalid');
        },
      },
    });
    expect(() => env.PORT).toThrow('invalid');
    runtimeEnv['PORT'] = '7';
    expect(env.PORT).toBe(7);
  });

  // A hot validated env is copied (fast path); a cold one and a skipped env over the caller's
  // object forward every read.
  describe.each([
    { path: 'validated, cold (forwarding)', skipValidation: false, hot: false },
    { path: 'validated, hot (copied)', skipValidation: false, hot: true },
    { path: 'skipped over caller runtimeEnv (live)', skipValidation: true, hot: true },
  ])('$path', ({ skipValidation, hot }) => {
    const make = () => {
      const env = defineEnv({ server, runtimeEnv: { PORT: '8080', NAME: 'billing' }, options: { skipValidation } });
      if (hot) warm(env);
      return env;
    };

    it('reads, enumerates and answers `in` like the built env', () => {
      const env = make();
      expect(env.PORT).toBe(skipValidation ? '8080' : 8080);
      expect(env.NAME).toBe('billing');
      expect(new Set(Object.keys(env))).toEqual(new Set(['NAME', 'PORT']));
      expect('PORT' in env).toBe(true);
      expect('MISSING' in env).toBe(false);
      expect(Reflect.get(env, 'MISSING')).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(env, 'PORT')).toBe(true);
    });

    it('reflects writes and deletes made through the env', () => {
      const env = make();
      void env.PORT;
      Reflect.set(env, 'NAME', 'changed');
      expect(env.NAME).toBe('changed');
      Reflect.deleteProperty(env, 'NAME');
      expect(env.NAME).toBeUndefined();
      expect('NAME' in env).toBe(false);
    });
  });

  it('returns undefined for symbols on a validated env, as createEnv does', () => {
    const env = defineEnv({ server, runtimeEnv: { PORT: '1' }, options: { skipValidation: false } });
    expect(Reflect.get(env, Symbol.iterator)).toBeUndefined();
    warm(env);
    expect(Reflect.get(env, Symbol.iterator)).toBeUndefined();
    expect(env.PORT).toBe(1);
  });

  it('keeps a skipped env over the caller runtimeEnv live', () => {
    const runtimeEnv: Record<string, string> = { PORT: '1' };
    const env = defineEnv({ server, runtimeEnv, options: { skipValidation: true } });
    expect(env.PORT).toBe('1');
    warm(env);
    runtimeEnv['PORT'] = '2';
    expect(env.PORT).toBe('2');
  });

  it('copies a skipped env it built from process.env', () => {
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- test-only variable, set and removed by this test
    process.env['DEFINE_ENV_TEST_PORT'] = '5';
    try {
      const env = defineEnv({
        server: { DEFINE_ENV_TEST_PORT: z.coerce.number() },
        options: { skipValidation: true },
      });
      warm(env);
      expect(env.DEFINE_ENV_TEST_PORT).toBe('5');
      expect(Object.keys(env)).toEqual(['DEFINE_ENV_TEST_PORT']);
      Reflect.set(env, 'DEFINE_ENV_TEST_PORT', '6');
      expect(env.DEFINE_ENV_TEST_PORT).toBe('6');
    } finally {
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- test-only variable, set and removed by this test
      delete process.env['DEFINE_ENV_TEST_PORT'];
    }
  });
});
