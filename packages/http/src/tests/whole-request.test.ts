/**
 * The contract describes the whole request and response: typed params and
 * headers, per-status responses, `reply`, `raw()`, the no-output 204 rule,
 * and the declaration-time checks (E011) behind them.
 */

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import { InvalidInput, isFailure } from '@arki/failure';

import type { HttpClientFailure } from '../client.js';
import type { ParamsOf } from '../contract.js';
import { reply, routes } from '../bundle.js';
import { createClient } from '../client.js';
import { route } from '../contract.js';
import { buildEngine } from '../compiled.js';
import { HTTP_ERROR_CODES } from '../error.js';
import { contractMeta, toOpenApi, toOpenApiFromManifest } from '../openapi.js';
import { raw } from '../raw.js';
import { codec, optional } from '../wire.js';

const BASE = 'http://test.local';

type OpenApiPaths = Record<string, Record<string, Record<string, unknown>>>;
const pathsOf = (document: Record<string, unknown>): OpenApiPaths => document['paths'] as OpenApiPaths;

/** Answers nothing: a no-output route answers 204. */
const answerNothing = (): void => {
  return;
};

const jsonOf = (request: Promise<Response>): Promise<unknown> => request.then(res => res.json());
const statusOf = (request: Promise<Response>): Promise<number> => request.then(res => res.status);

const OrderId = z
  .string()
  .regex(/^o\d+$/)
  .brand<'OrderId'>();
const Order = z.object({ id: z.string() });
const Gone = z.object({ reason: z.string() });

const getOrder = route.get('/orders/:id', {
  id: 'orders.get',
  params: { id: OrderId },
  headers: { 'x-tenant': z.string() },
  output: Order,
  responses: { 410: Gone },
});

const listOrders = route.get('/lists/:kind?', {
  id: 'lists.get',
  params: { kind: optional(z.string()) },
  output: z.object({ kind: z.string() }),
});

const calls = vi.fn();
const engine = buildEngine([
  routes()
    .bind(getOrder, ({ params, headers }) => {
      calls();
      expectTypeOf(params.id).toEqualTypeOf<z.infer<typeof OrderId>>();
      if (params.id === 'o410') return reply(410, { reason: 'gone' }, { headers: { 'x-why': 'sold' } });
      return { id: `${headers['x-tenant']}:${params.id}` };
    })
    .bind(listOrders, ({ params }) => ({ kind: params.kind ?? 'all' })),
]);

afterEach(() => {
  calls.mockClear();
});

describe('declaration checks (E011)', () => {
  const invalid = (declare: () => unknown): void => {
    expect(declare).toThrowError(expect.objectContaining({ code: HTTP_ERROR_CODES.invalidContract }));
  };

  it('rejects params that do not match the path placeholders, in both directions', () => {
    // @ts-expect-error -- params has no key for ":id"
    invalid(() => route.get('/a/:id', { id: 'x', params: { other: z.string() } }));
    invalid(() => route.get('/a/:id', { id: 'x', params: { id: z.string(), extra: z.string() } }));
    // @ts-expect-error -- params is a record of fields, not one schema
    invalid(() => route.get('/a/:id', { id: 'x', params: z.object({ id: z.string() }) }));
  });

  it('allows one optional placeholder, as the last segment, and pairs it with an optional(...) field', () => {
    invalid(() => route.get('/a/:x?/b', { id: 'x' }));
    invalid(() => route.get('/a/:x?/:y?', { id: 'x' }));
    invalid(() => route.get('/a/:x?', { id: 'x', params: { x: z.string() } }));
    invalid(() => route.get('/a/:x', { id: 'x', params: { x: optional(z.string()) } }));
    expect(route.get('/a/:x?', { id: 'x', params: { x: optional(z.string()) } }).path).toBe('/a/:x?');
  });

  it('requires lower-case header names', () => {
    invalid(() => route.get('/a', { id: 'x', headers: { 'X-Tenant': z.string() } }));
  });

  it('rejects statuses that cannot carry a declared body, and a 200 next to output', () => {
    invalid(() => route.get('/a', { id: 'x', responses: { 204: z.undefined() } }));
    invalid(() => route.get('/a', { id: 'x', responses: { 304: z.undefined() } }));
    invalid(() => route.get('/a', { id: 'x', responses: { 99: Gone } }));
    invalid(() => route.get('/a', { id: 'x', output: Order, responses: { 200: Order } }));
    // A raw route may document its 200.
    expect(route.get('/a', { id: 'x', output: raw(), responses: { 200: Order } }).id).toBe('x');
  });

  it('applies to SSE contracts too', () => {
    invalid(() => route.sse('/a/:id', { id: 'x', event: z.number(), params: { id: z.string(), extra: z.string() } }));
  });

  it('types ParamsOf with optional placeholders', () => {
    expectTypeOf<ParamsOf<'/a/:id/b/:x?'>>().toEqualTypeOf<{ readonly id: string; readonly x?: string }>();
    invalid(() => {
      // @ts-expect-error -- params has no key for the placeholder ":id"
      return route.get('/a/:id', { id: 'x', params: {} });
    });
  });
});

describe('params and headers', () => {
  it('parses params and headers into the handler input', async () => {
    const res = await engine.fetch(new Request(`${BASE}/orders/o1`, { headers: { 'x-tenant': 't1', accept: '*/*' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 't1:o1' });
  });

  it('answers 400 before the handler runs when a param or header is invalid', async () => {
    const badParam = await engine.fetch(new Request(`${BASE}/orders/nope`, { headers: { 'x-tenant': 't1' } }));
    expect(badParam.status).toBe(400);
    expect(await badParam.json()).toMatchObject({
      error: { code: InvalidInput.code, data: { issues: [{ path: ['params', 'id'] }] } },
    });
    const noHeader = await engine.fetch(new Request(`${BASE}/orders/o1`));
    expect(noHeader.status).toBe(400);
    expect(await noHeader.json()).toMatchObject({
      error: { code: InvalidInput.code, data: { issues: [{ path: ['headers', 'x-tenant'] }] } },
    });
    expect(calls).not.toHaveBeenCalled();
  });

  it('validates params on the async path too (a deriver makes the route async)', async () => {
    const derived = buildEngine([
      routes()
        .derive('who', () => 'ada')
        .bind(getOrder, () => ({ id: 'x' })),
    ]);
    const res = await derived.fetch(new Request(`${BASE}/orders/nope`, { headers: { 'x-tenant': 't1' } }));
    expect(res.status).toBe(400);
  });

  it('serves an optional placeholder with and without the value', async () => {
    expect(await jsonOf(engine.fetch(new Request(`${BASE}/lists/books`)))).toEqual({ kind: 'books' });
    expect(await jsonOf(engine.fetch(new Request(`${BASE}/lists`)))).toEqual({ kind: 'all' });
  });

  it('claims both expansions of an optional path, in either registration order', () => {
    const plain = route.get('/lists', { id: 'plain', output: raw() });
    const claim = (...bindings: ('plain' | 'optional')[]): void => {
      let builder = routes();
      for (const which of bindings) {
        builder =
          which === 'plain'
            ? builder.bind(plain, () => new Response('p'))
            : builder.bind(listOrders, () => ({ kind: 'k' }));
      }
      buildEngine([builder]);
    };
    expect(() => claim('plain', 'optional')).toThrowError(
      expect.objectContaining({ code: HTTP_ERROR_CODES.duplicateRoute }),
    );
    expect(() => claim('optional', 'plain')).toThrowError(
      expect.objectContaining({ code: HTTP_ERROR_CODES.duplicateRoute }),
    );
  });
});

describe('responses and reply', () => {
  it('answers a declared status with its schema, and adds the reply headers', async () => {
    const res = await engine.fetch(new Request(`${BASE}/orders/o410`, { headers: { 'x-tenant': 't1' } }));
    expect(res.status).toBe(410);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-why')).toBe('sold');
    expect(await res.json()).toEqual({ reason: 'gone' });
  });

  it('answers 500 E511 for an undeclared status', async () => {
    const wrong = route.get('/wrong', { id: 'wrong', output: Order, responses: { 410: Gone } });
    const e = buildEngine([routes().bind(wrong, () => reply(410, { reason: 'x' }))]);
    // Runtime violation of an erased binding: the declared status exists, so go through a second contract.
    const loose = route.get('/loose', { id: 'loose', output: Order });
    const erased = buildEngine([
      {
        derivers: [],
        mounts: [],
        bindings: [{ contract: loose, handler: () => reply(418, {}) }],
      },
    ]);
    const declared = await e.fetch(new Request(`${BASE}/wrong`));
    expect(declared.status).toBe(410);
    const res = await erased.fetch(new Request(`${BASE}/loose`));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: HTTP_ERROR_CODES.invalidResponse } });
  });

  it('answers 500 when a reply body violates its response schema', async () => {
    const bad = route.get('/bad', { id: 'bad', responses: { 410: Gone } });
    const e = buildEngine([
      {
        derivers: [],
        mounts: [],
        bindings: [{ contract: bad, handler: () => reply(410, { reason: 5 }) }],
      },
    ]);
    const res = await e.fetch(new Request(`${BASE}/bad`));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: HTTP_ERROR_CODES.internal } });
  });
});

describe('no output means 204', () => {
  const nothing = route.delete('/things/:id', { id: 'things.delete' });
  const e = buildEngine([routes().bind(nothing, answerNothing)]);

  it('answers 204 with an empty body and no content type', async () => {
    const res = await e.fetch(new Request(`${BASE}/things/1`, { method: 'DELETE' }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('content-type')).toBeNull();
  });

  it('answers 500 E511 when a no-output handler returns a value', async () => {
    const erased = buildEngine([
      { derivers: [], mounts: [], bindings: [{ contract: nothing, handler: () => ({ oops: true }) }] },
    ]);
    const res = await erased.fetch(new Request(`${BASE}/things/1`, { method: 'DELETE' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: HTTP_ERROR_CODES.invalidResponse } });
  });
});

describe('raw()', () => {
  const file = route.get('/file', { id: 'file', output: raw({ contentType: 'text/plain' }) });
  const plain = route.get('/plain', { id: 'plain', output: Order });

  it('passes a Response through untouched, a stream included', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed'));
        controller.close();
      },
    });
    const response = new Response(body, { status: 206 });
    const e = buildEngine([routes().bind(file, () => response)]);
    const res = await e.fetch(new Request(`${BASE}/file`));
    expect(res).toBe(response);
    expect(await res.text()).toBe('streamed');
  });

  describe.each(['development', 'production'])('under NODE_ENV=%s', env => {
    const original = process.env.NODE_ENV;
    afterEach(() => {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    });

    it('rejects a Response without raw(), and a value from a raw route, on the sync and async path', async () => {
      process.env.NODE_ENV = env;
      const erased = (contract: typeof file | typeof plain, handler: () => unknown, derivers = false) =>
        buildEngine([
          {
            derivers: derivers ? [{ key: 'k', derive: () => 1 }] : [],
            mounts: [],
            bindings: [{ contract, handler }],
          },
        ]);
      for (const derivers of [false, true]) {
        const response = await erased(plain, () => new Response('x'), derivers).fetch(new Request(`${BASE}/plain`));
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ error: { code: HTTP_ERROR_CODES.rawResponseMismatch } });
        const value = await erased(file, () => ({ id: 'a' }), derivers).fetch(new Request(`${BASE}/file`));
        expect(value.status).toBe(500);
        expect(await value.json()).toMatchObject({ error: { code: HTTP_ERROR_CODES.rawResponseMismatch } });
      }
    });
  });
});

describe('sse params and headers', () => {
  it('validates them before the stream opens', async () => {
    const ticks = route.sse('/ticks/:room', {
      id: 'ticks',
      params: { room: z.enum(['a', 'b']) },
      headers: { 'x-tenant': z.string() },
      event: z.number(),
    });
    const handler = vi.fn(async function* () {
      yield 1;
    });
    const e = buildEngine([routes().bind(ticks, handler)]);
    expect(await statusOf(e.fetch(new Request(`${BASE}/ticks/zzz`, { headers: { 'x-tenant': 't' } })))).toBe(400);
    expect(await statusOf(e.fetch(new Request(`${BASE}/ticks/a`)))).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    const ok = await e.fetch(new Request(`${BASE}/ticks/a`, { headers: { 'x-tenant': 't' } }));
    expect(await ok.text()).toBe('data: 1\n\n');
  });
});

describe('OpenAPI', () => {
  const download = route.get('/files/:name', {
    id: 'files.get',
    params: { name: z.string().meta({ id: 'FileName' }) },
    output: raw({ contentType: 'application/pdf' }),
    responses: { 200: z.string() },
  });
  const wipe = route.delete('/things', { id: 'things.wipe' });
  const contracts = [getOrder, listOrders, download, wipe];
  const info = { title: 'shop', version: '1.0.0' };
  const paths = pathsOf(toOpenApi(contracts, info));

  it('renders typed path and header parameters and every declared status', () => {
    const op = paths['/orders/{id}']!['get']!;
    expect(op['parameters']).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
      expect.objectContaining({ name: 'x-tenant', in: 'header', required: true, schema: { type: 'string' } }),
    ]);
    expect(Object.keys(op['responses'] as object)).toEqual(['200', '410']);
    expect(op['responses']).toMatchObject({
      '410': { content: { 'application/json': { schema: { type: 'object' } } } },
    });
  });

  it('renders an optional placeholder as two paths with distinct operation ids', () => {
    expect(Object.keys(paths)).toContain('/lists/{kind}');
    expect(paths['/lists/{kind}']!['get']!['operationId']).toBe('lists.get');
    expect(paths['/lists']!['get']!['operationId']).toBe('lists.get.without-kind');
    expect(paths['/lists']!['get']!['parameters']).toBeUndefined();
    expect(Object.keys(paths).some(path => path.includes('?'))).toBe(false);
  });

  it('marks raw routes, keeps the content type, and gives no-output routes a 204', () => {
    expect(paths['/files/{name}']!['get']!['x-arki-raw']).toBe(true);
    expect(paths['/files/{name}']!['get']!['responses']).toMatchObject({
      '200': { content: { 'application/pdf': { schema: { type: 'string' } } } },
    });
    expect(paths['/things']!['delete']!['responses']).toEqual({ '204': { description: 'no content' } });
  });

  it('keeps $defs as components, so a lifted parameter still resolves', () => {
    const parameters = paths['/files/{name}']!['get']!['parameters'] as { schema: unknown }[];
    expect(parameters[0]?.schema).toEqual({ $ref: '#/components/schemas/FileName' });
    expect(toOpenApi(contracts, info)['components']).toEqual({ schemas: { FileName: { type: 'string' } } });
  });

  it('describes codecs by their wire form', () => {
    const isoDate = codec(
      z.iso.datetime().transform(text => new Date(text)),
      z.date().transform(date => date.toISOString()),
    );
    const at = codec(z.object({ at: isoDate.decode }), z.object({ at: isoDate.encode }));
    const when = route.get('/when', { id: 'when', query: { at: isoDate }, output: at });
    const op = pathsOf(toOpenApi([when], info))['/when']!['get']!;
    expect(JSON.stringify(op)).toContain('"format":"date-time"');
  });

  it('renders the same document from the contracts and from a manifest', () => {
    const manifest = {
      app: { name: 'shop', version: '1.0.0' },
      actions: contracts.map(contract => ({
        ...contractMeta(contract),
        plugin: 'shop',
      })),
    };
    const strip = (paths: OpenApiPaths): unknown =>
      JSON.parse(JSON.stringify(paths, (key, value: unknown) => (key === 'tags' ? undefined : value))) as unknown;
    expect(strip(pathsOf(toOpenApiFromManifest(manifest)))).toEqual(strip(paths));
    expect(pathsOf(toOpenApiFromManifest(manifest))['/orders/{id}']!['get']!['tags']).toEqual(['shop']);
  });

  it('rejects an optional path that collides with a plain one', () => {
    const plain = route.get('/lists', { id: 'plain' });
    expect(() => toOpenApi([listOrders, plain], info)).toThrowError(
      expect.objectContaining({ code: HTTP_ERROR_CODES.duplicateRoute }),
    );
  });
});

describe('client', () => {
  const clientRoutes = buildEngine([
    routes()
      .bind(getOrder, ({ params, headers }) =>
        params.id === 'o410' ? reply(410, { reason: 'gone' }) : { id: `${headers['x-tenant']}:${params.id}` },
      )
      .bind(listOrders, ({ params }) => ({ kind: params.kind ?? 'all' }))
      .bind(route.delete('/things/:id', { id: 'things.delete' }), answerNothing)
      .bind(route.get('/file', { id: 'file', output: raw() }), () => new Response('bytes')),
  ]);
  const api = createClient(
    {
      getOrder,
      listOrders,
      remove: route.delete('/things/:id', { id: 'things.delete' }),
      file: route.get('/file', { id: 'file', output: raw() }),
    },
    { baseUrl: BASE, fetch: (url, init) => clientRoutes.fetch(new Request(url, init)) },
  );

  it('sends typed params and headers, and decodes by output and by declared status', async () => {
    const id = OrderId.parse('o1');
    expect(await api.getOrder({ params: { id }, headers: { 'x-tenant': 't' } })).toEqual({ id: 't:o1' });
    expect(await api.getOrder({ params: { id: OrderId.parse('o410') }, headers: { 'x-tenant': 't' } })).toEqual({
      reason: 'gone',
    });
  });

  it('drops a missing optional segment', async () => {
    expect(await api.listOrders()).toEqual({ kind: 'all' });
    expect(await api.listOrders({ params: { kind: 'books' } })).toEqual({ kind: 'books' });
  });

  it('resolves undefined on 204 and the Response for raw()', async () => {
    expect(await api.remove({ params: { id: '1' } })).toBeUndefined();
    const file = await api.file();
    if (isFailure(file)) throw new Error(file.code);
    expect(await file.text()).toBe('bytes');
  });

  it('types the result from the contract', () => {
    expectTypeOf(api.remove).returns.resolves.toEqualTypeOf<undefined | HttpClientFailure>();
    expectTypeOf(api.file).returns.resolves.toEqualTypeOf<Response | HttpClientFailure>();
    expectTypeOf(api.getOrder).returns.resolves.toEqualTypeOf<
      z.output<typeof Order> | z.output<typeof Gone> | HttpClientFailure
    >();
    // @ts-expect-error -- the order id is branded; a plain string is rejected
    void api.getOrder({ params: { id: 'o1' }, headers: { 'x-tenant': 't' } });
  });
});
