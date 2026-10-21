import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { StandardSchemaV1 } from './types.js';
import { assert, ensure, is } from './assert.js';
import { AssertError, SCHEMA_ERROR_CODES } from './errors.js';

const SECRET = 'sk-live-4242-do-not-print';

/** The error a callback throws, or undefined when it does not throw. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

const asyncSchema: StandardSchemaV1<unknown, string> = {
  '~standard': { version: 1, vendor: 'hand', validate: () => Promise.resolve({ value: 'late' }) },
};

/** Four vendors that each accept `{ port: number }`. */
const vendors = {
  zod: z.object({ port: z.number() }),
  valibot: v.object({ port: v.number() }),
  arktype: type({ port: 'number' }),
};

describe('is', () => {
  it.each(Object.entries(vendors))('is a plain yes/no check with %s, so a bad value never throws', (_, schema) => {
    expect(is({ port: 80 }, schema)).toBe(true);
    expect(is({ port: 'x' }, schema)).toBe(false);
  });

  it('throws asyncAssert for an async schema, because false would silently mean "invalid" for data that may be fine', () => {
    expect(thrownBy(() => is('x', asyncSchema))).toMatchObject({ code: SCHEMA_ERROR_CODES.asyncAssert });
  });
});

describe('assert', () => {
  it.each(Object.entries(vendors))('lists issues with their paths for %s', (_, schema) => {
    const error = thrownBy(() => {
      assert({ port: 'x' }, schema);
    });
    expect(error).toBeInstanceOf(AssertError);
    expect(error).toMatchObject({ code: SCHEMA_ERROR_CODES.assertFailed });
    expect(error instanceof AssertError && error.issues.length > 0).toBe(true);
    expect(error instanceof AssertError && error.message).toContain('port');
  });

  it('never transforms: the value it checked is the value the caller keeps', () => {
    const input = { port: '8080' };
    assert(input, z.object({ port: z.coerce.number() }));
    expect(input.port).toBe('8080');
  });

  it('puts the label and the lazy message in the error, and builds the message only on failure', () => {
    let built = 0;
    const message = () => {
      built += 1;
      return 'bad config';
    };
    assert(1, z.number(), { message });
    expect(built).toBe(0);
    const error = thrownBy(() => {
      assert('x', z.number(), { message, at: 'PORT' });
    });
    expect(built).toBe(1);
    expect(error instanceof Error && error.message).toContain('bad config');
    expect(error instanceof Error && error.message).toContain('PORT');
  });

  it('throws asyncAssert right away for an async schema, never a Promise and never a hang', () => {
    const error = thrownBy(() => {
      assert('x', asyncSchema);
    });
    expect(error).toBeInstanceOf(AssertError);
    expect(error).toMatchObject({ code: SCHEMA_ERROR_CODES.asyncAssert });
  });

  it('keeps the schema bug as the cause when the validator itself throws, instead of calling the data invalid', () => {
    const bug = new TypeError('boom');
    const buggy: StandardSchemaV1<unknown, string> = {
      '~standard': {
        version: 1,
        vendor: 'buggy',
        validate: () => {
          throw bug;
        },
      },
    };
    const error = thrownBy(() => {
      assert('x', buggy);
    });
    expect(error instanceof Error && error.cause).toBe(bug);
  });
});

describe('ensure', () => {
  it('returns the schema output, so ensure is a throwing parse', () => {
    expect(ensure('8080', z.coerce.number())).toBe(8080);
    expect(
      ensure(
        'ab',
        v.pipe(
          v.string(),
          v.transform(s => s.length),
        ),
      ),
    ).toBe(2);
  });

  it('throws assertFailed with the same issues that parse reports', () => {
    const error = thrownBy(() => ensure('x', z.number(), { at: 'PORT' }));
    expect(error).toMatchObject({ code: SCHEMA_ERROR_CODES.assertFailed });
    expect(error instanceof AssertError && error.message).toContain('PORT');
  });

  it('throws asyncAssert for an async schema', () => {
    expect(thrownBy(() => ensure('x', asyncSchema))).toMatchObject({ code: SCHEMA_ERROR_CODES.asyncAssert });
  });
});

describe('AssertError never leaks the value, because values in asserts are often secrets', () => {
  const schemas = {
    zod: z.object({ token: z.number() }),
    valibot: v.object({ token: v.number() }),
    arktype: type({ token: 'number' }),
  };
  it.each(Object.entries(schemas))('%s: message and issues exclude the secret', (_, schema) => {
    const error = thrownBy(() => {
      assert({ token: SECRET }, schema, { at: 'config' });
    });
    expect(error).toBeInstanceOf(AssertError);
    expect(error instanceof AssertError && error.message).not.toContain(SECRET);
    expect(JSON.stringify(error instanceof AssertError && error.issues)).not.toContain(SECRET);
  });

  it('redacts a root-level secret too', () => {
    const error = thrownBy(() => {
      ensure(12_345_678, v.string());
    });
    expect(error instanceof AssertError && error.message).not.toContain('12345678');
  });

  it('catches a hand-written schema that echoes the value, quoted, in its message', () => {
    const echo: StandardSchemaV1<unknown, string> = {
      '~standard': {
        version: 1,
        vendor: 'hand',
        validate: value => ({ issues: [{ message: `got ${JSON.stringify(value)}`, path: ['k'] }] }),
      },
    };
    const error = thrownBy(() => {
      assert({ k: SECRET }, echo);
    });
    expect(error instanceof AssertError && error.message).not.toContain(SECRET);
  });
});

describe('redaction does not garble the rest of the message', () => {
  const echo = (text: (value: unknown) => string): StandardSchemaV1<unknown, string> => ({
    '~standard': { version: 1, vendor: 'hand', validate: value => ({ issues: [{ message: text(value) }] }) },
  });
  const messageOf = (value: unknown, schema: StandardSchemaV1<unknown, unknown>): string => {
    const error = thrownBy(() => {
      assert(value, schema);
    });
    return error instanceof Error ? error.message : '';
  };

  it('a one-letter value leaves "Expected" intact', () => {
    const message = messageOf('e', v.number());
    expect(message).toContain('Expected');
    expect(message).not.toContain('"e"');
  });

  it('a value equal to a word of the message leaves that word alone', () => {
    const message = messageOf(
      'string',
      echo(value => `Expected string, got ${JSON.stringify(value)}`),
    );
    expect(message).toContain('Expected string');
    expect(message).not.toContain('"string"');
  });

  it('a number is removed as a whole token, not from inside the bound', () => {
    const message = messageOf(1, v.pipe(v.number(), v.minValue(10)));
    expect(message).toContain('10');
    expect(message).not.toMatch(/received 1\b/);
  });
});
