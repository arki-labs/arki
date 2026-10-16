import { inspect } from 'node:util';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { type } from 'arktype';
import * as v from 'valibot';
import { z } from 'zod';

import type { StandardSchemaV1 } from '@arki/schema';
import { SCHEMA_ERROR_CODES } from '@arki/schema';

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

  describe('takes any Standard Schema, because env must not tie callers to zod', () => {
    const handWritten: StandardSchemaV1<unknown, string> = {
      '~standard': {
        version: 1,
        vendor: 'hand',
        validate: value => (typeof value === 'string' ? { value } : { issues: [{ message: 'not a string' }] }),
      },
    };
    const schemas = { zod: z.string(), valibot: v.string(), arktype: type('string'), handWritten };

    for (const [name, inner] of Object.entries(schemas)) {
      it(`${name}: redacts a valid value and reports a bad one as issues`, () => {
        const wrapped = secret(inner)['~standard'];
        const ok = wrapped.validate(KEY);
        expect(ok).toHaveProperty('value');
        if (!('value' in ok)) throw new Error('expected a value');
        expect(reveal(ok.value)).toBe(KEY);
        expect(String(ok.value) + JSON.stringify(ok.value)).not.toContain(KEY);
        expect(wrapped.validate(42)).toHaveProperty('issues');
      });

      it(`${name}: .optional() lets undefined through unwrapped and still validates a present value`, () => {
        const wrapped = secret(inner).optional()['~standard'];
        const unset: { readonly API_KEY?: string } = {};
        expect(wrapped.validate(unset.API_KEY)).toEqual({ value: undefined });
        const present = wrapped.validate(KEY);
        if (!('value' in present)) throw new Error('expected a value');
        expect(reveal(present.value)).toBe(KEY);
        expect(String(present.value)).toBe('[redacted]');
        expect(wrapped.validate(42)).toHaveProperty('issues');
      });
    }

    it('fails an async inner schema with the same E001 as without secret, so its remediation stays right', () => {
      const asyncSchema: StandardSchemaV1<unknown, string> = {
        '~standard': { version: 1, vendor: 'async', validate: value => Promise.resolve({ value: String(value) }) },
      };
      const read = (schema: StandardSchemaV1) => () =>
        defineEnv({ server: { TOKEN: schema }, runtimeEnv: { TOKEN: KEY }, options: { skipValidation: false } })
          .TOKEN;
      const asyncResult = expect.objectContaining({ code: SCHEMA_ERROR_CODES.asyncResult });
      expect(read(asyncSchema)).toThrow(asyncResult);
      expect(read(secret(asyncSchema))).toThrow(asyncResult);
    });

    it('never echoes the rejected value in its issues, even when the vendor message does', () => {
      // valibot's messages include the received value: `Received "sk_live_…"`.
      const leaky = v.pipe(v.string(), v.email());
      expect(JSON.stringify(v.safeParse(leaky, KEY).issues)).toContain(KEY);
      let reported = '';
      const read = () =>
        defineEnv({
          server: { TOKEN: secret(leaky) },
          runtimeEnv: { TOKEN: KEY },
          options: {
            skipValidation: false,
            onValidationError: issues => {
              reported = JSON.stringify(issues);
              throw new Error('invalid');
            },
          },
        }).TOKEN;
      expect(read).toThrow('invalid');
      expect(reported).toContain('TOKEN');
      expect(reported).not.toContain(KEY);
    });

    it('a missing optional variable is fine in defineEnv, a present one is redacted', () => {
      const made = (runtimeEnv: Record<string, string | undefined>) =>
        defineEnv({
          server: { TOKEN: secret(v.string()).optional() },
          runtimeEnv,
          options: { skipValidation: false },
        });
      expect(made({}).TOKEN).toBeUndefined();
      expect(String(made({ TOKEN: KEY }).TOKEN)).toBe('[redacted]');
    });
  });
});
