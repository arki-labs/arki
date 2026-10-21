/**
 * The queue accepts any Standard Schema validator for job input, not only Zod.
 * Why it matters: a job's input schema is the caller's choice; the queue must
 * infer the handler's data from the schema OUTPUT and report bad data as a
 * `InvalidInput` with `issues`, whatever library built the schema.
 * Each schema takes a string and returns its length, so input and output types
 * differ and a mix-up shows in the types. No Redis needed.
 */
import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { FailureOf } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';
import { InvalidInput, UnexpectedFailure, ValidatorDefect } from '@arki/failure';
import { parseAsync } from '@arki/schema';

import { initQueue } from './init.ts';
import { customValidationMiddleware, JobValidationError } from './middleware/validation.ts';

const hand: StandardSchemaV1<string, number> = {
  '~standard': {
    version: 1,
    vendor: 'hand',
    validate: value =>
      typeof value === 'string'
        ? { value: value.length }
        : { issues: [{ message: 'not a string', path: [{ key: 'name' }] }] },
  },
};

const schemas = {
  hand,
  zod: z.string().transform(text => text.length),
  valibot: v.pipe(
    v.string(),
    v.transform(text => text.length),
  ),
  arktype: type('string').pipe(text => text.length),
};

const q = initQueue.context<{ readonly userId: string }>().create();

const job = {
  id: 'job-1',
  name: 'standard-schema:job',
  data: undefined,
  attemptsMade: 0,
  updateProgress: () => Promise.resolve(),
  log: () => Promise.resolve(),
};

describe.each(Object.entries(schemas))('job input from a %s schema', (_vendor, schema) => {
  it('infers the handler data from the schema output and parses with it', async () => {
    const definition = q.job
      .name(`standard-schema.${_vendor}`)
      .input(schema)
      .handler(data => {
        expectTypeOf(data).toEqualTypeOf<number>();
        return Promise.resolve();
      });

    await expect(parseAsync(definition._internal.inputSchema, 'four')).resolves.toBe(4);
  });

  it('rejects a handler that claims another input type, because the job only ever gets the schema output', () => {
    q.job
      .name(`standard-schema.${_vendor}.wrong-input`)
      .input(schema)
      // @ts-expect-error the schema returns a number, so the handler cannot take a string
      .handler((data: string) => Promise.resolve(data.length));
  });

  it('reports bad data as InvalidInput with issues', async () => {
    const error = await parseAsync(schema, 42).catch((error_: unknown) => error_);
    expect(InvalidInput.is(error)).toBe(true);
  });

  it('validation middleware bridges InvalidInput through the worker exception contract', async () => {
    const failures: FailureOf<typeof InvalidInput>[] = [];
    const middleware = customValidationMiddleware<undefined, number>({
      schema,
      onError: error => failures.push(error),
    });
    let nextCalled = false;
    const run = (data: unknown) =>
      middleware({
        ctx: undefined,
        data,
        job,
        meta: {},
        next: () => {
          nextCalled = true;
          return Promise.resolve({ ctx: undefined });
        },
      });

    await run('ok');
    expect(nextCalled).toBe(true);

    nextCalled = false;
    const error = await run(42).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(UnexpectedFailure);
    expect(error instanceof UnexpectedFailure && InvalidInput.is(error.failure)).toBe(true);
    expect(failures).toHaveLength(1);
    expect(nextCalled).toBe(false);
  });
});

describe('validation middleware', () => {
  it('lets a throwing validator propagate: a broken schema is a bug, not bad input', async () => {
    const thrown = new Error('boom');
    const broken: StandardSchemaV1<unknown, number> = {
      '~standard': {
        version: 1,
        vendor: 'broken',
        validate: () => {
          throw thrown;
        },
      },
    };
    const middleware = customValidationMiddleware<undefined, number>({ schema: broken });
    const error = await middleware({
      ctx: undefined,
      data: 1,
      job,
      meta: {},
      next: () => Promise.resolve({ ctx: undefined }),
    }).catch((error_: unknown) => error_);
    expect(error).not.toBeInstanceOf(JobValidationError);
    expect(error).toBeInstanceOf(UnexpectedFailure);
    expect(error instanceof UnexpectedFailure && ValidatorDefect.is(error.failure)).toBe(true);
    expect(error instanceof UnexpectedFailure && error.failure.cause).toBe(thrown);
  });

  it('normalizes {key} path segments into JSON-safe issue paths', async () => {
    const error = await parseAsync(hand, 1).catch((error_: unknown) => error_);
    expect(InvalidInput.is(error) && error.data.issues[0]?.path).toEqual(['name']);
  });
});
