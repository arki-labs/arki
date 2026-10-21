/**
 * Contracts take any Standard Schema, not only zod. The engine decodes with
 * the schema's own `validate`, a `codec()` carries the encode side, an
 * `optional()` marker decides `?:`, `check` sees the decoded request, and
 * OpenAPI reads each schema's own JSON Schema converter — or fails loudly.
 */

import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { StandardSchemaV1 } from '@arki/schema';
import { withJsonSchema } from '@arki/schema';

import { routes } from '../bundle.js';
import { createClient } from '../client.js';
import { route } from '../contract.js';
import { buildEngine } from '../compiled.js';
import { HTTP_ERROR_CODES } from '../error.js';
import { toOpenApi } from '../openapi.js';
import { codec, optional } from '../wire.js';

const BASE = 'http://test.local';

/** String in, its length out: input and output types differ, so a mix-up shows. */
const hand: StandardSchemaV1<string, number> = {
  '~standard': {
    version: 1,
    vendor: 'hand',
    validate: value =>
      typeof value === 'string' ? { value: value.length } : { issues: [{ message: 'not a string' }] },
  },
};
const zodLength = z.string().transform(text => text.length);
const valibotLength = v.pipe(
  v.string(),
  v.transform(text => text.length),
);
const arktypeLength = type('string').pipe(text => text.length);

/** `{ user: { age: number } }`, reporting its issue path as `{ key }` segments. */
const handUser: StandardSchemaV1<{ user: { age: number } }> = {
  '~standard': {
    version: 1,
    vendor: 'hand',
    validate: value =>
      typeof value === 'object' &&
      value !== null &&
      'user' in value &&
      typeof value.user === 'object' &&
      value.user !== null &&
      'age' in value.user &&
      typeof value.user.age === 'number'
        ? { value: { user: { age: value.user.age } } }
        : { issues: [{ message: 'age must be a number', path: [{ key: 'user' }, { key: 'age' }] }] },
  },
};

const send = (engine: { fetch: (req: Request) => Promise<Response> }, path: string, init?: RequestInit) =>
  engine.fetch(new Request(`${BASE}${path}`, init));

/** The JSON body of a request's answer. */
const bodyOf = (engine: { fetch: (req: Request) => Promise<Response> }, path: string): Promise<unknown> =>
  send(engine, path).then(res => res.json());
const statusOf = (engine: { fetch: (req: Request) => Promise<Response> }, path: string): Promise<number> =>
  send(engine, path).then(res => res.status);

/** A handler with nothing to return: the route answers 204. */
const nothing = (): void => {
  return;
};

const messageOf = async (res: Response): Promise<string> => {
  const body: unknown = await res.json();
  const parsed = z.object({ error: z.object({ message: z.string() }) }).parse(body);
  return parsed.error.message;
};

describe('four kinds of schema', () => {
  const lengths = route.get('/lengths', {
    id: 'lengths',
    query: { a: hand, b: zodLength, c: valibotLength, d: arktypeLength },
    output: z.object({ total: z.number() }),
  });
  const engine = buildEngine([
    routes().bind(lengths, ({ query }) => {
      expectTypeOf(query).toEqualTypeOf<{
        readonly a: number;
        readonly b: number;
        readonly c: number;
        readonly d: number;
      }>();
      return { total: query.a + query.b + query.c + query.d };
    }),
  ]);

  it('decodes a query field with each vendor, handing the handler the output type', async () => {
    const res = await send(engine, '/lengths?a=1&b=22&c=333&d=4444');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 10 });
  });

  it('answers 400 naming every field that fails, whichever vendor rejected it', async () => {
    const res = await send(engine, '/lengths?a=1');
    expect(res.status).toBe(400);
    const message = await messageOf(res);
    for (const key of ['query.b', 'query.c', 'query.d']) expect(message).toContain(key);
  });

  it('prefixes `{ key }` path segments with where the value came from', async () => {
    const save = route.post('/users', { id: 'users.save', body: handUser });
    const users = buildEngine([routes().bind(save, nothing)]);
    const res = await send(users, '/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: { age: 'old' } }),
    });
    expect(res.status).toBe(400);
    expect(await messageOf(res)).toBe('request validation failed: body.user.age: age must be a number');
  });
});

describe('codec()', () => {
  const isoDate = codec(
    z.iso.datetime().transform(text => new Date(text)),
    z.date().transform(date => date.toISOString()),
  );
  const shift = route.get('/shift', {
    id: 'shift',
    query: { at: isoDate },
    output: codec(z.object({ at: isoDate.decode }), z.object({ at: isoDate.encode })),
  });
  const engine = buildEngine([
    routes().bind(shift, ({ query }) => {
      expectTypeOf(query.at).toEqualTypeOf<Date>();
      return { at: new Date(query.at.getTime() + 1000) };
    }),
  ]);

  it('round-trips a field: the server decodes the wire string and encodes the Date it returns', async () => {
    const res = await send(engine, '/shift?at=1970-01-01T00:00:00.000Z');
    expect(await res.json()).toEqual({ at: '1970-01-01T00:00:01.000Z' });
  });

  it('round-trips through the client too: a Date in, a Date out, a string on the wire', async () => {
    const sent: string[] = [];
    const client = createClient(shift, {
      baseUrl: BASE,
      fetch: (url, init) => {
        sent.push(url);
        return engine.fetch(new Request(url, init));
      },
    });
    expect(await client({ query: { at: new Date(0) } })).toEqual({ at: new Date(1000) });
    expect(sent).toEqual([`${BASE}/shift?at=1970-01-01T00%3A00%3A00.000Z`]);
  });

  it('rejects a pair that does not reverse at compile time', () => {
    const broken = codec(
      z.string().transform(Number),
      // @ts-expect-error -- encode takes a Date, but decode hands out a number
      z.date().transform(date => date.toISOString()),
    );
    expect(broken.decode).toBeDefined();
  });
});

describe('optional()', () => {
  const list = route.get('/items', {
    id: 'items.list',
    query: { page: optional(z.coerce.number().int()), q: z.string() },
    output: z.object({ page: z.number().nullable() }),
  });
  const engine = buildEngine([
    routes().bind(list, ({ query }) => {
      expectTypeOf(query).toEqualTypeOf<{ readonly q: string; readonly page?: number | undefined }>();
      return { page: query.page ?? null };
    }),
  ]);

  it('lets a missing key reach the handler as undefined, without running the schema', async () => {
    expect(await bodyOf(engine, '/items?q=x')).toEqual({ page: null });
    expect(await bodyOf(engine, '/items?q=x&page=3')).toEqual({ page: 3 });
  });

  it('still decodes a present key and still requires an unmarked one', async () => {
    expect(await statusOf(engine, '/items?q=x&page=abc')).toBe(400);
    const missing = await send(engine, '/items');
    expect(missing.status).toBe(400);
    expect(await messageOf(missing)).toContain('query.q');
  });
});

describe('check', () => {
  const range = route.get('/range', {
    id: 'range',
    query: { from: z.coerce.number(), to: z.coerce.number() },
    output: z.object({ span: z.number() }),
    check: ({ query }) => {
      expectTypeOf(query.from).toEqualTypeOf<number>();
      return query.to < query.from ? [{ message: 'must not be before from', path: ['query', 'to'] }] : undefined;
    },
  });
  const engine = buildEngine([routes().bind(range, ({ query }) => ({ span: query.to - query.from }))]);

  it('answers 400 with where.key: message when the fields disagree', async () => {
    const res = await send(engine, '/range?from=5&to=1');
    expect(res.status).toBe(400);
    expect(await messageOf(res)).toBe('request validation failed: query.to: must not be before from');
  });

  it('types its input from the fields declared next to it', () => {
    const typed = route.get('/typed', {
      id: 'typed',
      query: { a: z.string() },
      check: ({ query, body }) => {
        expectTypeOf(body).toEqualTypeOf<undefined>();
        // @ts-expect-error -- the query declares no "nope"
        return query.nope === undefined ? undefined : [];
      },
    });
    expect(typed.check).toBeTypeOf('function');
  });

  it('lets a consistent request through', async () => {
    expect(await bodyOf(engine, '/range?from=1&to=5')).toEqual({ span: 4 });
  });
});

describe('a validator that throws', () => {
  const throwing: StandardSchemaV1<string, string> = {
    '~standard': {
      version: 1,
      vendor: 'broken',
      validate: () => {
        throw new Error('validator bug');
      },
    },
  };

  it('answers 500, not 400: a broken schema is the server bug, not a bad request', async () => {
    const get = route.get('/broken', { id: 'broken', query: { q: throwing } });
    const engine = buildEngine([routes().bind(get, nothing)]);
    const res = await send(engine, '/broken?q=x');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: HTTP_ERROR_CODES.internal } });
  });

  it('accepts an async schema on the sync path', async () => {
    const slow = z.string().refine(async text => {
      await Promise.resolve();
      return text === 'ok';
    }, 'not ok');
    const get = route.get('/slow', { id: 'slow', query: { q: slow }, output: z.object({ q: z.string() }) });
    const engine = buildEngine([routes().bind(get, ({ query }) => ({ q: query.q }))]);
    expect(await bodyOf(engine, '/slow?q=ok')).toEqual({ q: 'ok' });
    expect(await statusOf(engine, '/slow?q=no')).toBe(400);
  });
});

describe('OpenAPI from Standard Schema', () => {
  const info = { title: 'shop', version: '1.0.0' };

  it('emits one parameter per field, required unless optional(...)', () => {
    const search = route.get('/search', {
      id: 'search',
      query: { q: z.string(), page: optional(z.coerce.number()) },
      headers: { 'x-tenant': arktypeLength },
    });
    const operation = z
      .object({ paths: z.object({ '/search': z.object({ get: z.object({ parameters: z.array(z.unknown()) }) }) }) })
      .parse(toOpenApi([search], info)).paths['/search'].get;
    expect(operation.parameters).toEqual([
      { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
      expect.objectContaining({ name: 'page', in: 'query', required: false }),
      { name: 'x-tenant', in: 'header', required: true, schema: { type: 'string' } },
    ]);
  });

  it('throws naming the route, the field and withJsonSchema for a schema with no converter', () => {
    const search = route.get('/search', { id: 'search', query: { page: valibotLength } });
    expect(() => toOpenApi([search], info)).toThrowError(
      expect.objectContaining({
        code: HTTP_ERROR_CODES.noJsonSchema,
        message: expect.stringContaining('route "search": query.page') as string,
        remediation: expect.stringContaining('withJsonSchema') as string,
      }),
    );
  });

  it('documents the schema once withJsonSchema gives it a JSON Schema', () => {
    const page = withJsonSchema(valibotLength, { type: 'string' });
    const search = route.get('/search', { id: 'search', query: { page } });
    expect(JSON.stringify(toOpenApi([search], info))).toContain('"name":"page","in":"query","required":true');
  });
});

const nothingBack = (): undefined => undefined;

describe('async validators and presence', () => {
  it('answers 500 for a fast rejection next to a slow validator, with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const slow: StandardSchemaV1<string, string> = {
        '~standard': {
          version: 1,
          vendor: 'slow',
          validate: value => new Promise(resolve => setTimeout(() => resolve({ value: String(value) }), 20)),
        },
      };
      const boom: StandardSchemaV1<string, string> = {
        '~standard': { version: 1, vendor: 'boom', validate: () => Promise.reject(new Error('boom')) },
      };
      const late: StandardSchemaV1<string, string> = {
        '~standard': {
          version: 1,
          vendor: 'late',
          validate: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 10)),
        },
      };
      const get = route.get('/many', { id: 'many', query: { a: slow, b: boom, c: late } });
      const engine = buildEngine([routes().bind(get, nothingBack)]);
      const res = await engine.fetch(new Request('http://x/many?a=1&b=2&c=3'));
      expect(res.status).toBe(500);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('does not strand started promises when a later validator throws synchronously', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const rejecting: StandardSchemaV1<string, string> = {
        '~standard': {
          version: 1,
          vendor: 'rej',
          validate: () => new Promise((_, reject) => setTimeout(() => reject(new Error('rej')), 5)),
        },
      };
      const throwing: StandardSchemaV1<string, string> = {
        '~standard': {
          version: 1,
          vendor: 'thr',
          validate: () => {
            throw new Error('thr');
          },
        },
      };
      const get = route.get('/mix', { id: 'mix', query: { a: rejecting, b: throwing } });
      const engine = buildEngine([routes().bind(get, nothingBack)]);
      const res = await engine.fetch(new Request('http://x/mix?a=1&b=2'));
      expect(res.status).toBe(500);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('treats a plain thenable result as async', async () => {
    const thenable: StandardSchemaV1<string, string> = {
      '~standard': {
        version: 1,
        vendor: 'thenable',
        validate: value => {
          const inner = Promise.resolve<StandardSchemaV1.Result<string>>({ value: String(value) });
          // Promise-shaped, but not a Promise instance.
          return {
            // A plain thenable is the case under test.
            // eslint-disable-next-line unicorn/no-thenable
            then: (onFulfilled, onRejected) => inner.then(onFulfilled, onRejected),
            catch: onRejected => inner.catch(onRejected),
            finally: onFinally => inner.finally(onFinally),
            [Symbol.toStringTag]: 'Promise',
          };
        },
      },
    };
    const get = route.get('/t', { id: 't', query: { q: thenable }, output: z.object({ q: z.string() }) });
    const engine = buildEngine([routes().bind(get, ({ query }) => ({ q: query.q }))]);
    const res = await engine.fetch(new Request('http://x/t?q=hi'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ q: 'hi' });
  });

  it('answers 400 for a missing field that is not optional(...), even if its schema accepts undefined', async () => {
    const get = route.get('/p', { id: 'p', query: { q: z.string().optional() } });
    const engine = buildEngine([routes().bind(get, nothingBack)]);
    const missing = await engine.fetch(new Request('http://x/p'));
    expect(missing.status).toBe(400);
    const marked = route.get('/m', { id: 'm', query: { q: optional(z.string().optional()) } });
    const markedEngine = buildEngine([routes().bind(marked, nothingBack)]);
    const absent = await markedEngine.fetch(new Request('http://x/m'));
    expect(absent.status).toBe(204);
  });
});

describe('OpenAPI $defs renaming', () => {
  it('keeps the suffix of a ref when a conflicting def is renamed', () => {
    const thing = (type: string) =>
      withJsonSchema(z.object({ v: z.string() }), {
        $ref: '#/$defs/Thing/properties/v',
        $defs: { Thing: { type: 'object', properties: { v: { type } } } },
      });
    const one = route.post('/one', { id: 'one', body: thing('string') });
    const two = route.post('/two', { id: 'two', body: thing('number') });
    const text = JSON.stringify(toOpenApi([one, two], { title: 'shop', version: '1.0.0' }));
    expect(text).toContain('#/components/schemas/Thing/properties/v');
    expect(text).toContain('#/components/schemas/Thing_2/properties/v');
  });

  it('renames a ref whose def name holds an escaped "/" (JSON Pointer ~1)', () => {
    // Without decoding `~1`, the second route's ref would still point at the first route's def.
    const thing = (type: string) =>
      withJsonSchema(z.object({ v: z.string() }), {
        $ref: '#/$defs/A~1B/properties/v',
        $defs: { 'A/B': { type: 'object', properties: { v: { type } } } },
      });
    const one = route.post('/one', { id: 'one', body: thing('string') });
    const two = route.post('/two', { id: 'two', body: thing('number') });
    const text = JSON.stringify(toOpenApi([one, two], { title: 'shop', version: '1.0.0' }));
    expect(text).toContain('#/components/schemas/A~1B/properties/v');
    expect(text).toContain('#/components/schemas/A~1B_2/properties/v');
  });
});
