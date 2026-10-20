import type { StandardSchemaV1 } from '@standard-schema/spec';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { RevivalFailure } from './revive.js';
import { defineFailure, isFailure } from './failure.js';
import { AsyncSchema, InvalidEnvelope, UnexpectedDefect, ValidatorDefect } from './foundations.js';
import { revive, reviveJson, serialize } from './revive.js';

const PostNotFound = defineFailure('post.not_found', {
  status: 404,
  data: z.object({ id: z.string() }),
  message: 'no post {id}',
});
const Unauthorized = defineFailure('auth.unauthorized', { status: 401 });
const definitions = [PostNotFound, Unauthorized] as const;

/** JSON, not structuredClone: transport must remove prototypes and native values. */
const overTheWire = (value: unknown): unknown => {
  const json = JSON.stringify(value);
  return JSON.parse(json);
};

describe('revive', () => {
  it('reads both stored versionless failures and version 1 using local metadata', () => {
    for (const wire of [overTheWire(PostNotFound({ id: 'p9' })), serialize(PostNotFound({ id: 'p9' }), definitions)]) {
      expect(isFailure(wire)).toBe(false);
      const result = revive(wire, definitions);
      expectTypeOf(result).toEqualTypeOf<ReturnType<(typeof definitions)[number]> | RevivalFailure | undefined>();
      expect(result).toMatchObject({ code: 'post.not_found', message: 'no post p9', status: 404 });
      expect(PostNotFound.is(result)).toBe(true);
    }
    expect(revive(overTheWire(Unauthorized()), definitions)).toMatchObject({ status: 401 });
  });

  it('distinguishes unrelated values, unknown codes, invalid data, and unsupported versions', () => {
    expect(revive({ id: 'p1' }, definitions)).toBeUndefined();
    expect(revive('unrelated', definitions)).toBeUndefined();
    expect(revive({ code: 'future.failure' }, definitions)).toMatchObject({ data: { reason: 'unknown_code' } });
    expect(revive({ code: PostNotFound.code, data: { id: 42 } }, definitions)).toMatchObject({
      data: { reason: 'invalid_data' },
    });
    expect(revive({ version: 2, code: Unauthorized.code }, definitions)).toMatchObject({
      data: { reason: 'unsupported_version' },
    });
    expect(revive({ version: 1 }, definitions)).toMatchObject({ data: { reason: 'malformed' } });
    expect(revive({ code: Unauthorized.code, data: 'unexpected' }, definitions)).toMatchObject({
      data: { reason: 'invalid_data' },
    });
  });

  it('does not trust a remote brand, message, status, remediation or cause', () => {
    const result = revive(
      {
        code: Unauthorized.code,
        '~failure': true,
        status: 200,
        message: 'approved',
        remediation: 'send token',
        cause: 'secret',
      },
      definitions,
    );
    expect(result).toEqual(Unauthorized());
    expect(result?.cause).toBeUndefined();
  });

  it('returns typed invalid JSON and does not expose rejected input or exceptions publicly', () => {
    const result = reviveJson('{secret', definitions);
    expect(InvalidEnvelope.is(result)).toBe(true);
    expect(result).toMatchObject({ data: { reason: 'invalid_json' } });
    expect(result?.cause).toBeInstanceOf(SyntaxError);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(reviveJson(JSON.stringify(Unauthorized()), definitions)).toEqual(Unauthorized());
  });

  it('rejects hostile accessors without calling them and contains proxy faults', () => {
    let called = false;
    const input = {
      get code() {
        called = true;
        throw new Error('secret');
      },
    };
    expect(revive(input, definitions)).toMatchObject({ data: { reason: 'malformed' } });
    expect(called).toBe(false);
    const proxy = new Proxy(
      {},
      {
        has() {
          throw new Error('secret');
        },
      },
    );
    expect(revive(proxy, definitions)).toMatchObject({ data: { reason: 'malformed' } });
    expect(JSON.stringify(revive(proxy, definitions))).not.toContain('secret');
  });

  it('returns async mismatch and validator defects instead of treating them as bad input', () => {
    const Slow = defineFailure('slow.check', { data: z.string().refine(() => Promise.resolve(true)) });
    expect(AsyncSchema.is(revive({ code: Slow.code, data: 'a' }, [Slow]))).toBe(true);
    const cause = new TypeError('private validator secret');
    const schema: StandardSchemaV1<string> = {
      '~standard': {
        version: 1,
        vendor: 'broken',
        validate() {
          throw cause;
        },
      },
    };
    const Broken = defineFailure('broken.schema', { data: schema });
    const result = revive({ code: Broken.code, data: 'a' }, [Broken]);
    expect(ValidatorDefect.is(result)).toBe(true);
    expect(result?.cause).toBe(cause);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('contains a broken message callback as a distinct unexpected defect', () => {
    const Broken = defineFailure('broken.message', {
      message() {
        throw new Error('secret');
      },
    });
    const result = revive({ code: Broken.code }, [Broken]);
    expect(UnexpectedDefect.is(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('distinguishes a declared canonical failure from a failure decoding that same definition', () => {
    const mapped: RevivalFailure[] = [];
    const options = {
      onInvalid(failure: RevivalFailure) {
        mapped.push(failure);
        return 'invalid' as const;
      },
    };
    const valid = revive(overTheWire(InvalidEnvelope({ reason: 'invalid_json' })), [InvalidEnvelope], options);
    expect(valid).toEqual(InvalidEnvelope({ reason: 'invalid_json' }));
    expect(mapped).toHaveLength(0);
    const invalid = revive({ code: InvalidEnvelope.code, data: { reason: 'made_up' } }, [InvalidEnvelope], options);
    expect(invalid).toBe('invalid');
    expect(mapped).toHaveLength(1);
    expectTypeOf(valid).toEqualTypeOf<ReturnType<typeof InvalidEnvelope> | 'invalid' | undefined>();
  });
});

describe('JSON-safe failure boundaries', () => {
  it('never applies a changing transform twice; idempotent validation is allowed', () => {
    const Changed = defineFailure('changed.data', { data: z.string().transform(value => `${value}!`) });
    const failure = Changed('a!');
    expect(serialize(failure, [Changed])).toMatchObject({ data: { reason: 'unstable_schema' } });
    expect(revive(overTheWire(failure), [Changed])).toMatchObject({ data: { reason: 'unstable_schema' } });
    const Trimmed = defineFailure('trimmed.data', { data: z.string().trim() });
    expect(revive(overTheWire(Trimmed('a')), [Trimmed])).toEqual(Trimmed('a'));
  });

  it.each([
    new Date(),
    new Map(),
    new Set(),
    1n,
    Number.NaN,
    Infinity,
    -0,
    { missing: undefined },
    [undefined],
    Object.assign([], { length: 2 }),
  ])('rejects data JSON would silently alter: %s', data => {
    const NonJson = defineFailure('non_json.data', { data: z.unknown() });
    expect(serialize(NonJson(data), [NonJson])).toMatchObject({ data: { reason: 'non_json_data' } });
  });

  it('rejects cycles, getters and toJSON hooks without leaking data or executing hooks', () => {
    const Unsafe = defineFailure('unsafe.data', { data: z.unknown() });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    let called = false;
    const accessor = {
      get password() {
        called = true;
        return 'secret';
      },
    };
    const hook = {
      toJSON() {
        called = true;
        return 'secret';
      },
    };
    for (const data of [cycle, accessor, hook]) {
      expect(InvalidEnvelope.is(serialize(Unsafe(data), [Unsafe]))).toBe(true);
    }
    expect(called).toBe(false);
  });

  it('copies safe data and drops presentation metadata and private causes', () => {
    const data = { id: 'p1' };
    const wire = serialize(PostNotFound(data, { cause: new Error('secret') }), definitions);
    data.id = 'mutated';
    expect(wire).toEqual({ version: 1, code: PostNotFound.code, data: { id: 'p1' } });
    expect(JSON.stringify(wire)).not.toContain('secret');
  });

  it('validates a detached snapshot so changing proxies cannot alter the approved wire data', () => {
    const Numeric = defineFailure('numeric.data', { data: z.object({ n: z.number() }) });
    const target = { n: 1 };
    let enumerations = 0;
    const data = new Proxy(target, {
      ownKeys(value) {
        enumerations++;
        if (enumerations > 1) value.n = 999;
        return Reflect.ownKeys(value);
      },
    });
    expect(serialize(Numeric(data), [Numeric])).toEqual({ version: 1, code: Numeric.code, data: { n: 1 } });
  });

  it('rejects an undeclared failure at compile time', () => {
    const check = () => {
      // @ts-expect-error The transport did not declare this failure.
      return serialize(Unauthorized(), [PostNotFound]);
    };
    expect(check).toBeTypeOf('function');
  });
});
