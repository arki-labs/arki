import { type } from 'arktype';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

import type { SchemaWithJson, StandardSchemaV1 } from '@arki/schema';

import { z } from '@arki/contracts';
import { withJsonSchema } from '@arki/schema';

import { ADMIN_ERROR_CODES, AdminError, defineAction, defineRead, defineSignal } from './module.ts';

/** A hand-written Standard Schema: a string that arrives as `"3"` and leaves as the number 3. */
const handWritten: StandardSchemaV1<string, number> = {
  '~standard': {
    version: 1,
    vendor: 'hand',
    validate: value =>
      typeof value === 'string' && /^\d+$/.test(value)
        ? { value: Number(value) }
        : { issues: [{ message: 'not digits', path: [{ key: 'count' }] }] },
  },
};
const countJson = { type: 'string', pattern: '^\\d+$' };
const countOutJson = { type: 'integer' };
const handWrittenWithJson = withJsonSchema(handWritten, countJson, countOutJson);

const out = z.object({ ok: z.boolean() });

describe('read output and undeclared keys', () => {
  // Output used to be zod-only, so undeclared keys were always dropped. Now the schema decides,
  // and the docs promise exactly this: a row's secret column reaches the client unless the
  // output schema drops it.
  const row = { ok: true, secret: 'hash' };
  const readWith = (id: string, output: StandardSchemaV1<unknown, { ok: boolean }>) =>
    defineRead({ id, summary: 's', permission: 'x:read', input: z.object({}), output, load: async () => row });

  it('drops undeclared keys with a zod object or an arktype object that deletes them', async () => {
    expect(await readWith('x.zodOut', z.object({ ok: z.boolean() })).run({}, null)).toEqual({ ok: true });
    expect(await readWith('x.arkDelete', type({ '+': 'delete', ok: 'boolean' })).run({}, null)).toEqual({ ok: true });
  });

  it('keeps undeclared keys with a plain arktype object', async () => {
    expect(await readWith('x.arkKeep', type({ ok: 'boolean' })).run({}, null)).toEqual(row);
  });
});

describe('reads accept any Standard Schema', () => {
  it('runs zod, valibot, arktype and hand-written input schemas', async () => {
    const readZod = defineRead({
      id: 'x.zod',
      summary: 's',
      permission: 'x:read',
      input: z.object({ n: z.string().transform(s => s.length) }),
      output: out,
      load: async input => ({ ok: input.n === 2 }),
    });
    const readValibot = defineRead({
      id: 'x.valibot',
      summary: 's',
      permission: 'x:read',
      input: withJsonSchema(v.object({ n: v.pipe(v.string(), v.transform(s => s.length)) }), { type: 'object' }),
      output: out,
      load: async input => ({ ok: input.n === 2 }),
    });
    const readArk = defineRead({
      id: 'x.ark',
      summary: 's',
      permission: 'x:read',
      input: type({ n: 'string' }),
      output: out,
      load: async input => ({ ok: input.n === 'ab' }),
    });
    const readHand = defineRead({
      id: 'x.hand',
      summary: 's',
      permission: 'x:read',
      input: handWrittenWithJson,
      output: out,
      // The handler sees the schema OUTPUT (a number), not the wire string.
      load: async input => ({ ok: input === 3 }),
    });
    expect(await readZod.run({ n: 'ab' }, null)).toEqual({ ok: true });
    expect(await readValibot.run({ n: 'ab' }, null)).toEqual({ ok: true });
    expect(await readArk.run({ n: 'ab' }, null)).toEqual({ ok: true });
    expect(await readHand.run('3', null)).toEqual({ ok: true });
    expect(readHand.jsonSchema.input).toEqual(countJson);
  });

  it('turns bad input into an invalid-input AdminError carrying the issue path', async () => {
    const read = defineRead({
      id: 'x.hand',
      summary: 's',
      permission: 'x:read',
      input: handWrittenWithJson,
      output: out,
      load: async () => ({ ok: true }),
    });
    const failure = await read.run('abc', null).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdminError);
    if (!(failure instanceof AdminError)) throw failure;
    expect(failure.code).toBe(ADMIN_ERROR_CODES.invalidInput);
    expect(failure.message).toContain('count');
  });

  it('lets a throwing validator propagate instead of reporting bad input', async () => {
    const boom: StandardSchemaV1<unknown, unknown> = {
      '~standard': {
        version: 1,
        vendor: 'boom',
        validate: () => {
          throw new Error('validator bug');
        },
      },
    };
    const read = defineRead({
      id: 'x.boom',
      summary: 's',
      permission: 'x:read',
      input: withJsonSchema(boom, { type: 'object' }),
      output: out,
      load: async () => ({ ok: true }),
    });
    const failure = await read.run({}, null).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(AdminError);
    expect(failure).toBeInstanceOf(Error);
  });
});

describe('JSON Schema comes from the schema itself', () => {
  it('uses the input projection for input and the output projection for results', () => {
    const read = defineRead({
      id: 'x.hand',
      summary: 's',
      permission: 'x:read',
      input: handWrittenWithJson,
      output: handWrittenWithJson,
      load: async () => '1',
    });
    expect(read.jsonSchema.input).toEqual(countJson);
    expect(read.jsonSchema.output).toEqual(countOutJson);
  });

  it('names the read and withJsonSchema when a schema has no converter', () => {
    expect(() =>
      defineRead({ id: 'x.bare', summary: 's', permission: 'x:read', input: handWritten, output: out, load: async () => ({ ok: true }) }),
    ).toThrow(/"x\.bare".*withJsonSchema/s);
  });

  it('names the action when a conversion throws', () => {
    const failing: SchemaWithJson<unknown, { revision: string }> = {
      '~standard': {
        version: 1,
        vendor: 'fails',
        validate: value => ({ value: { revision: String(value) } }),
        jsonSchema: {
          input: () => {
            throw new Error('no map');
          },
          output: () => {
            throw new Error('no map');
          },
        },
      },
    };
    expect(() =>
      defineAction({
        id: 'x.act',
        summary: 's',
        permission: 'x:write',
        risk: 'low',
        input: out,
        previewOutput: failing,
        output: out,
        preview: async () => 'r1',
        execute: async () => ({ ok: true }),
      }),
    ).toThrow(/"x\.act".*withJsonSchema/s);
  });

  it('accepts a Standard Schema signal payload', () => {
    const signal = defineSignal({ id: 'x.sig', summary: 's', payload: handWrittenWithJson });
    expect(signal.jsonSchema.payload).toEqual(countOutJson);
  });
});
