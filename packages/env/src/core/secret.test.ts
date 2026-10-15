import { inspect } from 'node:util';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Redacted } from './secret.js';
import { defineEnv } from './define-env.js';
import { reveal, secret } from './secret.js';

const KEY = 'sk_live_123';

const takesString = (value: string) => value;

describe('secret', () => {
  const env = defineEnv({
    server: { STRIPE_KEY: secret(z.string().min(1)), WEBHOOK_SECRET: secret(z.string()).optional() },
    runtimeEnv: { STRIPE_KEY: KEY },
    options: { skipValidation: false },
  });

  it('types the variable as a Redacted value, so it cannot be passed where a string is expected', () => {
    expectTypeOf(env.STRIPE_KEY).toEqualTypeOf<Redacted<string>>();
    expectTypeOf(env.WEBHOOK_SECRET).toEqualTypeOf<Redacted<string> | undefined>();
    // @ts-expect-error -- a secret must be revealed on purpose
    takesString(env.STRIPE_KEY);
    expectTypeOf(reveal(env.STRIPE_KEY)).toEqualTypeOf<string>();
  });

  it('never prints the value: logs, JSON, template strings and inspect all show [redacted]', () => {
    const asText = [
      JSON.stringify({ env: { STRIPE_KEY: env.STRIPE_KEY } }),
      String(env.STRIPE_KEY),
      `${String(env.STRIPE_KEY)}`,
      inspect({ STRIPE_KEY: env.STRIPE_KEY }),
      inspect(env.STRIPE_KEY),
      JSON.stringify(Object.keys(env.STRIPE_KEY)),
    ].join('\n');
    expect(asText).not.toContain(KEY);
    expect(asText).toContain('[redacted]');
  });

  it('reveals the value where it is needed, and treats a missing optional secret as absent', () => {
    expect(reveal(env.STRIPE_KEY)).toBe(KEY);
    expect(env.WEBHOOK_SECRET).toBeUndefined();
  });

  it('still reveals when validation was skipped and the variable is a plain string', () => {
    const skipped = defineEnv({
      server: { STRIPE_KEY: secret(z.string()) },
      runtimeEnv: { STRIPE_KEY: KEY },
      options: { skipValidation: true },
    });
    expect(reveal(skipped.STRIPE_KEY)).toBe(KEY);
  });

  it('fails validation like the inner schema does: a secret is still checked', () => {
    expect(
      () =>
        defineEnv({
          server: { STRIPE_KEY: secret(z.string().min(1)) },
          runtimeEnv: { STRIPE_KEY: undefined },
          options: {
            skipValidation: false,
            onValidationError: () => {
              throw new Error('invalid');
            },
          },
        }).STRIPE_KEY,
    ).toThrow('invalid');
  });
});
