/* eslint-disable unicorn/no-thenable -- Foreign thenables are intentional validator protocol fixtures. */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { FailureOf } from './failure.js';
import type { AsyncSchemaFailure, SchemaFailure } from './schema.js';
import { defineFailure, isFailure } from './failure.js';
import {
  AsyncSchema,
  INVALID_ENVELOPE_REASONS,
  InvalidEnvelope,
  InvalidInput,
  UnexpectedDefect,
  ValidatorDefect,
} from './foundations.js';
import { executeSchema, executeSchemaAsync } from './schema-executor.js';
import { isAsyncSchemaFailure, isSchemaFailure, parse, parseAsync } from './schema.js';

function schema<Output>(
  validate: StandardSchemaV1.Props<unknown, Output>['validate'],
): StandardSchemaV1<unknown, Output> {
  return { '~standard': { version: 1, vendor: 'test', validate } };
}

/** Mutate only the test's untyped edge to exercise a dishonest foreign validator. */
function foreignResult(result: unknown) {
  const validator = schema(() => ({ value: 'unused' }));
  Object.defineProperty(validator['~standard'], 'validate', { value: () => result });
  return validator;
}

const numeric = schema<number>(value =>
  typeof value === 'string' ? { value: value.length } : { issues: [{ message: 'Expected a string.' }] },
);

describe('Standard Schema execution', () => {
  it('returns transformed outputs directly and keeps failure types exact', async () => {
    const result = parse(numeric, 'abc');
    expect(result).toBe(3);
    expect(await parseAsync(numeric, 'abcd')).toBe(4);
    expectTypeOf(result).toEqualTypeOf<number | SchemaFailure>();
    expectTypeOf<SchemaFailure>().toEqualTypeOf<
      ReturnType<typeof InvalidInput> | ReturnType<typeof AsyncSchema> | ReturnType<typeof ValidatorDefect>
    >();
    expectTypeOf<AsyncSchemaFailure>().toEqualTypeOf<
      ReturnType<typeof InvalidInput> | ReturnType<typeof ValidatorDefect>
    >();
    const Unrelated = defineFailure('test.unrelated');
    expect(Unrelated.code).toBe('test.unrelated');
    expectTypeOf<Extract<FailureOf<typeof parse<never>>, ReturnType<typeof Unrelated>>>().toBeNever();
  });

  it('preserves the standard properties receiver', async () => {
    const bound = {
      '~standard': {
        version: 1,
        vendor: 'receiver',
        validate() {
          return { value: this.vendor };
        },
      },
    } satisfies StandardSchemaV1;
    expect(parse(bound, null)).toBe('receiver');
    expect(await parseAsync(bound, null)).toBe('receiver');
  });

  it('makes invalid input a canonical failure, copying only public issue fields', () => {
    const invalid = schema(() => ({
      issues: [{ message: 'Required.', path: [{ key: 'email' }, 0, Symbol('field')], input: 'secret' }],
    }));
    const result = parse(invalid, { password: 'secret' });
    expect(InvalidInput.is(result)).toBe(true);
    if (!InvalidInput.is(result)) throw new Error('Expected invalid input.');
    expect(result.status).toBe(400);
    expect(result.data).toEqual({ issues: [{ message: 'Required.', path: ['email', 0, 'Symbol(field)'] }] });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('does not confuse a successfully validated failure value with execution failure', async () => {
    const output = InvalidInput({ issues: [{ message: 'This is a successful output.' }] });
    const validator = schema(() => ({ value: output }));
    const execution = executeSchema(validator, null);
    expect(isFailure(execution)).toBe(false);
    expect(execution).toEqual({ value: output });
    expect(await executeSchemaAsync(validator, null)).toEqual({ value: output });
    expect(parse(validator, null)).toBe(output);
    expect(await parseAsync(validator, null)).toBe(output);
  });

  it('accepts undefined output and a non-callable then field', () => {
    expect(
      parse(
        schema(() => ({ value: undefined })),
        null,
      ),
    ).toBeUndefined();
    expect(
      parse(
        schema(() => ({ value: 'ok', then: 42 })),
        null,
      ),
    ).toBe('ok');
  });

  it('reports async mismatch while observing rejected dropped results', async () => {
    const cause = new Error('secret rejection');
    expect(
      AsyncSchema.is(
        parse(
          schema(() => Promise.resolve({ value: 1 })),
          null,
        ),
      ),
    ).toBe(true);
    expect(
      AsyncSchema.is(
        parse(
          schema(() => Promise.reject(cause)),
          null,
        ),
      ),
    ).toBe(true);
    // Vitest also fails this test if the rejection escapes as unhandled.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });

  it('observes rejected native promises even when their then getter throws', async () => {
    const cause = new Error('secret then accessor');
    const rejected = Promise.reject(new Error('secret original rejection'));
    void Object.defineProperty(rejected, 'then', {
      get() {
        throw cause;
      },
    });
    const result = parse(
      schema(() => rejected),
      null,
    );
    expect(ValidatorDefect.is(result)).toBe(true);
    if (!ValidatorDefect.is(result)) throw new Error('Expected a validator defect.');
    expect(result.cause).toBe(cause);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });

  it('observes rejected derived promises when async assimilation cannot read then', async () => {
    class DeferredResult extends Promise<StandardSchemaV1.Result<number>> {}
    const rejected = DeferredResult.reject<StandardSchemaV1.Result<number>>(new Error('private rejection'));
    const cause = new Error('private then accessor');
    void Object.defineProperty(rejected, 'then', {
      get() {
        throw cause;
      },
    });
    const result = await parseAsync(
      schema(() => rejected),
      null,
    );
    expect(ValidatorDefect.is(result)).toBe(true);
    if (!ValidatorDefect.is(result)) throw new Error('Expected a validator defect.');
    expect(result.cause).toBe(cause);
    // Vitest treats an escaped original rejection as a failing test.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });

  it('narrows generic parser outputs to exactly the canonical failure closure', () => {
    function detect<Output>(value: Output | SchemaFailure) {
      return isSchemaFailure(value) ? value : null;
    }
    function detectAsync<Output>(value: Output | AsyncSchemaFailure) {
      return isAsyncSchemaFailure(value) ? value : null;
    }
    expectTypeOf<ReturnType<typeof detect>>().toEqualTypeOf<SchemaFailure | null>();
    expectTypeOf<ReturnType<typeof detectAsync>>().toEqualTypeOf<AsyncSchemaFailure | null>();
    expect(detect(AsyncSchema())).toEqual(AsyncSchema());
    expect(detectAsync(AsyncSchema())).toBeNull();
    expect(detect(UnexpectedDefect())).toBeNull();
  });

  it('accepts resolving foreign thenables and observes rejecting ones', async () => {
    const resolving = foreignResult({ then: (resolve: (value: unknown) => void) => resolve({ value: 'resolved' }) });
    const rejecting = foreignResult({
      then: (_resolve: unknown, reject: (value: unknown) => void) => reject('secret'),
    });
    expect(AsyncSchema.is(parse(resolving, null))).toBe(true);
    expect(await parseAsync(resolving, null)).toBe('resolved');
    expect(AsyncSchema.is(parse(rejecting, null))).toBe(true);
    const rejected = await parseAsync(rejecting, null);
    expect(ValidatorDefect.is(rejected)).toBe(true);
    if (!ValidatorDefect.is(rejected)) throw new Error('Expected a validator defect.');
    expect(rejected.cause).toBe('secret');
    expect(JSON.stringify(rejected)).not.toContain('secret');
  });

  it('keeps synchronous throws and asynchronous rejections private', async () => {
    const cause = new Error('secret validator details');
    const throwing = schema<never>(() => {
      throw cause;
    });
    const rejected = schema<never>(() => Promise.reject(cause));
    for (const result of [parse(throwing, null), await parseAsync(throwing, null), await parseAsync(rejected, null)]) {
      expect(ValidatorDefect.is(result)).toBe(true);
      if (!ValidatorDefect.is(result)) throw new Error('Expected a validator defect.');
      expect(result.cause).toBe(cause);
      expect(result.status).toBe(500);
      expect(JSON.stringify(result)).not.toContain('secret');
    }
  });

  it.each(['~standard', 'version', 'vendor', 'validate'])('contains a hostile %s accessor', async property => {
    const cause = new Error(`secret ${property}`);
    const validator = schema(() => ({ value: 1 }));
    Object.defineProperty(property === '~standard' ? validator : validator['~standard'], property, {
      get() {
        throw cause;
      },
    });
    for (const result of [parse(validator, null), await parseAsync(validator, null)]) {
      expect(ValidatorDefect.is(result)).toBe(true);
      if (!ValidatorDefect.is(result)) throw new Error('Expected a validator defect.');
      expect(result.cause).toBe(cause);
      expect(JSON.stringify(result)).not.toContain('secret');
    }
  });

  it.each(['then', 'issues', 'value'])('contains a hostile result %s accessor', async property => {
    const cause = new Error(`secret ${property}`);
    const result = { value: 1 };
    Object.defineProperty(result, property, {
      get() {
        throw cause;
      },
    });
    const validator = foreignResult(result);
    for (const parsed of [parse(validator, null), await parseAsync(validator, null)]) {
      expect(ValidatorDefect.is(parsed)).toBe(true);
      if (!ValidatorDefect.is(parsed)) throw new Error('Expected a validator defect.');
      expect(parsed.cause).toBe(cause);
    }
  });

  it('contains hostile issue, path and path-key inspection', async () => {
    const cause = new Error('secret issue details');
    const issue = { message: 'Required.' };
    Object.defineProperty(issue, 'path', {
      get() {
        throw cause;
      },
    });
    const segment = {};
    Object.defineProperty(segment, 'key', {
      get() {
        throw cause;
      },
    });
    const cases = [
      { issues: [issue] },
      { issues: [{ message: 'Required.', path: [segment] }] },
      {
        issues: new Proxy([], {
          get() {
            throw cause;
          },
        }),
      },
    ];
    for (const result of cases) {
      expect(ValidatorDefect.is(parse(foreignResult(result), null))).toBe(true);
      expect(ValidatorDefect.is(await parseAsync(foreignResult(result), null))).toBe(true);
    }
  });

  it.each([
    null,
    undefined,
    1,
    false,
    'value',
    {},
    { issues: null },
    { issues: [{}] },
    { issues: [{ message: 1 }] },
    { issues: [{ message: 'bad', path: {} }] },
    { issues: [{ message: 'bad', path: [null] }] },
    { issues: [{ message: 'bad', path: [Infinity] }] },
  ])('classifies malformed results as defects rather than invalid input: %j', async result => {
    expect(ValidatorDefect.is(parse(foreignResult(result), null))).toBe(true);
    expect(ValidatorDefect.is(await parseAsync(foreignResult(result), null))).toBe(true);
  });
});

describe('bootstrap failure definitions', () => {
  it('locks canonical input-data schema output to canonical issue types in both directions', () => {
    expectTypeOf<StandardSchemaV1.InferOutput<NonNullable<typeof InvalidInput.dataSchema>>>().toEqualTypeOf<{
      issues: readonly StandardSchemaV1.Issue[];
    }>();
    expect(InvalidInput.is(parse(numeric, null))).toBe(true);
    expect(InvalidInput.is(parse(InvalidInput.dataSchema, { issues: [{}] }))).toBe(true);
    expect(parse(InvalidInput.dataSchema, { issues: [{ message: 'Required.', input: 'private' }] })).toEqual({
      issues: [{ message: 'Required.' }],
    });
  });

  it('derives envelope reasons from one runtime list', () => {
    expectTypeOf<StandardSchemaV1.InferOutput<NonNullable<typeof InvalidEnvelope.dataSchema>>>().toEqualTypeOf<{
      reason: (typeof INVALID_ENVELOPE_REASONS)[number];
    }>();
    for (const reason of INVALID_ENVELOPE_REASONS) {
      expect(parse(InvalidEnvelope.dataSchema, { reason })).toEqual({ reason });
    }
    expect(InvalidInput.is(parse(InvalidEnvelope.dataSchema, { reason: 'invented' }))).toBe(true);
  });

  it('keeps unexpected defects distinct from exception bridges and hides causes', () => {
    const result = UnexpectedDefect({ cause: new Error('sensitive cause details') });
    expect(result.code).toBe('failure.unexpected_defect');
    expect(result.status).toBe(500);
    expect(result).not.toBeInstanceOf(Error);
    expect(JSON.stringify(result)).not.toContain('sensitive cause details');
  });
});

it('keeps the declared schema boundary definitions equal to the inferred parser failures', async () => {
  const { SCHEMA_FAILURES } = await import('./schema.js');
  expectTypeOf<ReturnType<(typeof SCHEMA_FAILURES)[number]>>().toEqualTypeOf<SchemaFailure>();
  expect(SCHEMA_FAILURES).toContain(InvalidInput);
});
