import { describe, expect, it } from 'vitest';

import { InvalidInput } from '@arki/failure';

import type { StandardSchemaV1 } from './types.js';
import { SCHEMA_ERROR_CODES, SchemaRunError } from './errors.js';
import { hasJsonSchema, isStandardSchema, withJsonSchema } from './guards.js';
import { parse } from './parse.js';

/** A schema whose `validate` reads `this`, the way class-based validators do. */
const props = {
  version: 1 as const,
  vendor: 'this-bound',
  min: 2,
  validate(value: unknown) {
    return typeof value === 'string' && value.length >= this.min
      ? { value }
      : { issues: [{ message: `at least ${String(this.min)} characters` }] };
  },
};
const minLength: StandardSchemaV1<string> = { '~standard': props };

describe('isStandardSchema', () => {
  it('accepts a callable schema, because ArkType types are functions', () => {
    const callable = Object.assign((value: unknown) => value, {
      '~standard': { version: 1, vendor: 'callable', validate: (value: unknown) => ({ value }) },
    });
    expect(isStandardSchema(callable)).toBe(true);
    expect(isStandardSchema(minLength)).toBe(true);
  });

  it('rejects values that only look like schemas', () => {
    expect(isStandardSchema(null)).toBe(false);
    expect(isStandardSchema({})).toBe(false);
    expect(isStandardSchema({ '~standard': { version: 2 } })).toBe(false);
    expect(isStandardSchema({ '~standard': { version: 1, vendor: 'x' } })).toBe(false);
    expect(isStandardSchema({ '~standard': { version: 1, vendor: 7, validate: () => ({ value: 1 }) } })).toBe(false);
  });

  it('refuses hostile protocol inspection without leaking a provider exception', () => {
    const revoked = Proxy.revocable(minLength, {});
    revoked.revoke();
    expect(isStandardSchema(revoked.proxy)).toBe(false);
    expect(
      isStandardSchema(
        new Proxy(minLength, {
          has() {
            throw new Error('private');
          },
        }),
      ),
    ).toBe(false);
    expect(
      isStandardSchema(
        new Proxy(minLength, {
          get() {
            throw new Error('private');
          },
        }),
      ),
    ).toBe(false);
    expect(hasJsonSchema(revoked.proxy)).toBe(false);
    expect(
      hasJsonSchema(
        new Proxy(minLength, {
          get() {
            throw new Error('private');
          },
        }),
      ),
    ).toBe(false);
  });

  it.each(['version', 'vendor', 'validate'])('observes an invalid async %s accessor without awaiting it', async key => {
    const invalid = {
      '~standard': new Proxy(props, {
        get(target, name, receiver) {
          return name === key ? Promise.reject(new Error('private rejection')) : Reflect.get(target, name, receiver);
        },
      }),
    };
    expect(isStandardSchema(invalid)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('observes invalid root/protocol promises and leaves arbitrary then accessors alone', async () => {
    expect(isStandardSchema(Promise.reject(new Error('private root')))).toBe(false);
    const invalid = new Proxy(minLength, {
      get() {
        return Promise.reject(new Error('private protocol'));
      },
    });
    expect(isStandardSchema(invalid)).toBe(false);
    expect(hasJsonSchema(invalid)).toBe(false);
    expect(hasJsonSchema(Object.assign(Promise.reject(new Error('private schema')), minLength))).toBe(false);
    let thenReads = 0;
    const protocol = new Proxy(props, {
      get(target, key, receiver) {
        if (key === 'then') {
          thenReads += 1;
          throw new Error('not a validator member');
        }
        return Reflect.get(target, key, receiver);
      },
    });
    expect(isStandardSchema({ '~standard': protocol })).toBe(true);
    expect(thenReads).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('observes rejected promises thrown by protocol accessors', async () => {
    const invalid = new Proxy(minLength, {
      get() {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Foreign accessors can throw a rejected Promise instead of an Error.
        throw Promise.reject(new Error('private thrown promise'));
      },
    });
    expect(isStandardSchema(invalid)).toBe(false);
    expect(hasJsonSchema(invalid)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('reserves observation before native promise species code can reenter inspection', async () => {
    const rejected = Promise.reject(new Error('private species rejection'));
    let reads = 0;
    void Object.defineProperty(rejected, 'constructor', {
      get() {
        reads += 1;
        expect(isStandardSchema(rejected)).toBe(false);
        return Promise;
      },
    });
    expect(isStandardSchema({ '~standard': rejected })).toBe(false);
    expect(isStandardSchema(rejected)).toBe(false);
    expect(reads).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('does not mutate a foreign promise whose constructor prevents handler registration', () => {
    // The language reads constructor/species before installing reactions; no portable bypass exists.
    const blocked = Promise.resolve();
    let reads = 0;
    const readConstructor = () => {
      reads += 1;
      throw new Error('unreadable constructor');
    };
    void Object.defineProperty(blocked, 'constructor', { get: readConstructor });
    expect(isStandardSchema({ '~standard': blocked })).toBe(false);
    expect(reads).toBe(1);
    expect(Object.getOwnPropertyDescriptor(blocked, 'constructor')).toMatchObject({ get: readConstructor });
  });
});

describe('withJsonSchema', () => {
  const json = { type: 'string', minLength: 2 };
  const wrapped = withJsonSchema(minLength, json);

  it('keeps validation working on the original object, so `this` and getters still resolve', () => {
    expect(parse(wrapped, 'abc')).toBe('abc');
    expect(parse(wrapped, 'a')).toMatchObject({
      code: InvalidInput.code,
      data: { issues: [{ message: 'at least 2 characters' }] },
    });
  });

  it('copies vendor and version, and answers draft-2020-12 with the given JSON Schema', () => {
    expect(wrapped['~standard']).toMatchObject({ version: 1, vendor: 'this-bound' });
    expect(wrapped['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toBe(json);
    expect(wrapped['~standard'].jsonSchema.output({ target: 'draft-2020-12' })).toBe(json);
  });

  it('uses a separate output JSON Schema when given one', () => {
    const output = { type: 'number' };
    const split = withJsonSchema(minLength, json, output);
    expect(split['~standard'].jsonSchema.output({ target: 'draft-2020-12' })).toBe(output);
  });

  it('throws E003 for any other target, since a draft-2020-12 document is wrong for them', () => {
    // The spec says a converter should throw for a target it does not support.
    expect(() => wrapped['~standard'].jsonSchema.input({ target: 'draft-07' })).toThrow(SchemaRunError);
    expect(() => wrapped['~standard'].jsonSchema.output({ target: 'openapi-3.0' })).toThrow(
      expect.objectContaining({ code: SCHEMA_ERROR_CODES.unsupportedTarget }),
    );
  });

  it('makes hasJsonSchema true, and leaves the original alone', () => {
    expect(hasJsonSchema(minLength)).toBe(false);
    expect(hasJsonSchema(wrapped)).toBe(true);
    expect('jsonSchema' in minLength['~standard']).toBe(false);
  });

  it.each(['input', 'output'])('refuses a broken %s converter without executing or awaiting it', async key => {
    const invalid = {
      '~standard': {
        ...props,
        jsonSchema: new Proxy(wrapped['~standard'].jsonSchema, {
          get(target, name, receiver) {
            return name === key
              ? Promise.reject(new Error('private converter rejection'))
              : Reflect.get(target, name, receiver);
          },
        }),
      },
    };
    expect(hasJsonSchema(invalid)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
