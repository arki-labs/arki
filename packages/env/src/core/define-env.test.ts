/**
 * The env `defineEnv()` returns is lazy. Once it has been read often enough, it reads from a private
 * copy of the values (a fast path) when that copy cannot drift from the built env. These tests pin
 * that the copy and the forwarding view behave the same way, and that a caller's own `runtimeEnv`
 * stays live.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defineEnv, formatIssues } from './define-env.js';
import { InvalidEnvironment } from './errors.js';

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

describe('defineEnv() validation default', () => {
  // The key is never set, so any read that validates must fail on it.
  const required = { DEFINE_ENV_DEFAULT_REQUIRED: z.string() };

  beforeEach(() => {
    vi.stubEnv('SKIP_ENV_VALIDATION', '');
    vi.spyOn(console, 'error').mockImplementation(vi.fn());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('validates even when CI is set and the script is lint', () => {
    // WHY: an ambient variable must never turn validation off, or production boots unchecked.
    vi.stubEnv('CI', 'true');
    vi.stubEnv('npm_lifecycle_event', 'lint');
    const env = defineEnv({ server: required });
    expect(() => Reflect.ownKeys(env)).toThrow('DEFINE_ENV_DEFAULT_REQUIRED');
  });

  it('skips when SKIP_ENV_VALIDATION is exactly 1', () => {
    // WHY: Docker build stages that prerender without secrets need one purpose-named opt-out.
    vi.stubEnv('SKIP_ENV_VALIDATION', '1');
    const env = defineEnv({ server: required });
    expect(() => Reflect.ownKeys(env)).not.toThrow();
  });

  it.each(['0', 'false', 'true'])('still validates when SKIP_ENV_VALIDATION is %s', value => {
    // WHY: only the exact string 1 opts out, so a stray "0" or "false" cannot disable checks.
    vi.stubEnv('SKIP_ENV_VALIDATION', value);
    const env = defineEnv({ server: required });
    expect(() => Reflect.ownKeys(env)).toThrow('DEFINE_ENV_DEFAULT_REQUIRED');
  });

  it('explicit skipValidation: true bypasses parsing and defaults', () => {
    // WHY: the explicit option wins; skipped values pass through raw, so defaults do not apply.
    const env = defineEnv({
      server: { PORT: z.coerce.number().default(3000) },
      runtimeEnv: { PORT: '8080' },
      options: { skipValidation: true },
    });
    expect(env.PORT).toBe('8080');
    const empty = defineEnv({
      server: { PORT: z.coerce.number().default(3000) },
      runtimeEnv: {},
      options: { skipValidation: true },
    });
    expect(empty.PORT).toBeUndefined();
  });

  it('explicit skipValidation: false beats SKIP_ENV_VALIDATION=1', () => {
    // WHY: code that insists on validation must not be silenced by the environment.
    vi.stubEnv('SKIP_ENV_VALIDATION', '1');
    const env = defineEnv({ server: required, options: { skipValidation: false } });
    expect(() => Reflect.ownKeys(env)).toThrow('DEFINE_ENV_DEFAULT_REQUIRED');
  });

  it('names every invalid key and the env label in the error', () => {
    // WHY: a failed deploy log must point at the exact variables.
    const env = defineEnv({
      name: '@x/backend',
      server: { DEFINE_ENV_A: z.string(), DEFINE_ENV_B: z.string() },
    });
    let message = '';
    try {
      Reflect.ownKeys(env);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('[@x/backend]');
    expect(message).toContain('DEFINE_ENV_A');
    expect(message).toContain('DEFINE_ENV_B');
  });

  it('does not throw at declaration, only on the first read', () => {
    // WHY: laziness keeps imports, `dot explain` and docs tooling free of secrets.
    expect(() => defineEnv({ server: required })).not.toThrow();
  });

  it('formatIssues flattens paths into one line per issue', () => {
    const text = formatIssues('x', [{ message: 'bad', path: ['A'] }, { message: 'worse' }]);
    expect(text).toContain('[x]');
    expect(text).toContain('  A: bad');
    expect(text).toContain('  (root): worse');
  });
});

describe('defineEnv() on an engine with no `process`', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads no values instead of throwing a ReferenceError, so Hermes and browsers can still declare and read an env', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- the point is a missing global, as on Hermes
    vi.stubGlobal('process', undefined);
    const env = defineEnv({ server: { NAME: z.string().default('app') } });
    expect(env.NAME).toBe('app');
  });

  it('still honours an explicit runtimeEnv, the documented way to feed an engine that has no process', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- the point is a missing global, as on Hermes
    vi.stubGlobal('process', undefined);
    const env = defineEnv({ server: { PORT: z.coerce.number() }, runtimeEnv: { PORT: '9000' } });
    expect(env.PORT).toBe(9000);
  });
});

describe('defineEnv() with a value that is still encrypted', () => {
  it('fails validation by name instead of accepting ciphertext as a string', () => {
    // WHY: Bun auto-loads .env files as written; without `dot env run` a Stripe key would be `encrypted:...`.
    const env = defineEnv({
      name: 'enc',
      server: { STRIPE_KEY: z.string(), PORT: z.coerce.number() },
      runtimeEnv: { STRIPE_KEY: 'encrypted:BDx1', PORT: '1' },
      options: {
        onValidationError: issues => {
          throw new Error(formatIssues('enc', issues));
        },
      },
    });
    expect(() => env.STRIPE_KEY).toThrow(/STRIPE_KEY: still encrypted: start the process with `dot env run/);
  });

  it('lets skipped validation through, as for every other value', () => {
    const env = defineEnv({ server: { K: z.string() }, runtimeEnv: { K: 'encrypted:x' }, options: { skipValidation: true } });
    expect(env.K).toBe('encrypted:x');
  });
});


describe('the default validation error', () => {
  it('is a typed InvalidEnvironment failure that still names the variable', () => {
    vi.spyOn(console, 'error').mockReturnValue();
    const env = defineEnv({ server: { PORT: z.coerce.number().int() }, runtimeEnv: { PORT: 'nope' }, options: { skipValidation: false } });
    expect(() => env.PORT).toThrow(expect.objectContaining({ code: 'env.invalid_environment', failure: expect.objectContaining({ code: InvalidEnvironment.code }) }));
    expect(() => env.PORT).toThrow(/PORT/);
  });
});
