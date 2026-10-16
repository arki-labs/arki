/**
 * `defineEnv()` takes any Standard Schema, not only Zod. Apps pick their validator; the env must parse
 * with it, type each value as the schema's OUTPUT (a port arrives as the string "8080" and is read as a
 * number), and name the failing variable down to the nested key when a schema reports `{ key }` path
 * segments, the way Valibot does.
 */

import type { StandardSchemaV1 } from '@arki/schema';
import { SCHEMA_ERROR_CODES, SchemaRunError } from '@arki/schema';
import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { defineEnv } from './define-env.js';

/** Hand-written schema: a decimal string in, a number out. No validator library involved. */
const portSchema: StandardSchemaV1<string, number> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: value => {
      const port = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
      return Number.isInteger(port) ? { value: port } : { issues: [{ message: 'not a port' }] };
    },
  },
};

const server = {
  HAND_PORT: portSchema,
  ZOD_PORT: z.coerce.number().int(),
  VALIBOT_FLAG: v.pipe(
    v.string(),
    v.transform(text => text === 'true'),
  ),
  ARK_COUNT: type('string.integer.parse'),
};

const runtimeEnv = { HAND_PORT: '8080', ZOD_PORT: '9090', VALIBOT_FLAG: 'true', ARK_COUNT: '3' };

/** Collects the error message instead of logging it, so assertions can read it. */
const failWith = (issues: readonly StandardSchemaV1.Issue[]): never => {
  throw new Error(JSON.stringify(issues.map(issue => issue.path)));
};

describe('defineEnv() with Standard Schema validators', () => {
  it('parses with each validator and types every value as its schema output, not its string input', () => {
    const env = defineEnv({ server, runtimeEnv });

    expect(env).toEqual({ HAND_PORT: 8080, ZOD_PORT: 9090, VALIBOT_FLAG: true, ARK_COUNT: 3 });
    expectTypeOf(env.HAND_PORT).toEqualTypeOf<number>();
    expectTypeOf(env.ZOD_PORT).toEqualTypeOf<number>();
    expectTypeOf(env.VALIBOT_FLAG).toEqualTypeOf<boolean>();
    expectTypeOf(env.ARK_COUNT).toEqualTypeOf<number>();
  });

  it('names the failing variable and its nested key when the schema reports `{ key }` segments', () => {
    const database = v.pipe(
      v.string(),
      v.parseJson(),
      v.object({ host: v.string() }),
    );
    const env = defineEnv({
      name: '@test/env',
      server: { DATABASE: database },
      runtimeEnv: { DATABASE: '{"host":1}' },
    });

    expect(() => env.DATABASE).toThrow(/\[@test\/env\][\s\S]*DATABASE\.host: /);
  });

  it('reports a failing hand-written schema under its variable name', () => {
    const env = defineEnv({
      server: { HAND_PORT: portSchema },
      runtimeEnv: { HAND_PORT: 'eighty' },
      options: { onValidationError: failWith },
    });

    expect(() => env.HAND_PORT).toThrow('[["HAND_PORT"]]');
  });

  it('fails an async validator as SchemaRunError E001, not as a bad variable, and leaves no unhandled rejection', async () => {
    const asyncSchema: StandardSchemaV1<string, string> = {
      '~standard': { version: 1, vendor: 'slow-vendor', validate: () => Promise.reject(new Error('network down')) },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    let reported = false;
    const env = defineEnv({
      server: { TOKEN: asyncSchema },
      runtimeEnv: { TOKEN: 'x' },
      options: {
        onValidationError: (): never => {
          reported = true;
          throw new Error('reported as invalid');
        },
      },
    });

    let thrown: unknown;
    try {
      Reflect.get(env, 'TOKEN');
    } catch (error) {
      thrown = error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    process.off('unhandledRejection', onUnhandled);

    expect(thrown).toBeInstanceOf(SchemaRunError);
    expect(thrown).toMatchObject({ code: SCHEMA_ERROR_CODES.asyncResult });
    expect(String(thrown)).toContain('slow-vendor');
    expect(reported).toBe(false);
    expect(unhandled).toEqual([]);
  });

  it('fails a throwing validator as SchemaRunError E002 that keeps the thrown cause, not as a bad variable', () => {
    const bug = new Error('validator bug');
    const throwing: StandardSchemaV1<string, string> = {
      '~standard': {
        version: 1,
        vendor: 'buggy',
        validate: () => {
          throw bug;
        },
      },
    };
    const env = defineEnv({
      server: { TOKEN: throwing },
      runtimeEnv: { TOKEN: 'x' },
      options: { onValidationError: failWith },
    });

    let thrown: unknown;
    try {
      Reflect.get(env, 'TOKEN');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SchemaRunError);
    expect(thrown).toMatchObject({ code: SCHEMA_ERROR_CODES.validatorThrew, cause: bug });
  });
});
