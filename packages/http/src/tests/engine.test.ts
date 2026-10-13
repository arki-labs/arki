/**
 * Engine behavior through the composed fetch handler — no sockets.
 * Validation envelopes, deriver pipeline, params/query/body delivery,
 * raw-Response passthrough, output-contract enforcement, mounts, 404s,
 * ambient context.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { routes } from '../bundle.js';
import { requestContext } from '../context.js';
import { route } from '../contract.js';
import { buildEngine, composeMiddleware } from '../engine.js';
import { HTTP_ERROR_CODES, HttpError } from '../error.js';

const BASE = 'http://test.local';

async function envelopeOf(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return body.error;
}

describe('buildEngine', () => {
  it('serves a bound contract: params, query, and output serialization', async () => {
    const getOrder = route.get('/orders/:id', {
      id: 'orders.get',
      query: z.object({ expand: z.string().optional() }),
      output: z.object({ id: z.string(), expand: z.string().optional() }),
    });
    const engine = buildEngine([
      routes().bind(getOrder, ({ params, query }) => ({
        id: params.id,
        ...(query.expand === undefined ? {} : { expand: query.expand }),
      })),
    ]);

    const res = await engine.fetch(new Request(`${BASE}/orders/o42?expand=items`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'o42', expand: 'items' });
    expect(engine.routeIds).toEqual(['orders.get']);
  });

  it('rejects invalid query with a 400 envelope', async () => {
    const list = route.get('/orders', {
      id: 'orders.list',
      query: z.object({ status: z.enum(['open', 'shipped']) }),
      output: z.array(z.string()),
    });
    const engine = buildEngine([routes().bind(list, () => [])]);

    const res = await engine.fetch(new Request(`${BASE}/orders?status=lost`));
    expect(res.status).toBe(400);
    const error = await envelopeOf(res);
    expect(error.code).toBe(HTTP_ERROR_CODES.badRequest);
    expect(error.message).toContain('status');
  });

  it('rejects non-JSON and schema-violating bodies with 400 envelopes', async () => {
    const create = route.post('/orders', {
      id: 'orders.create',
      body: z.object({ sku: z.string() }),
      output: z.object({ ok: z.boolean() }),
    });
    const engine = buildEngine([routes().bind(create, () => ({ ok: true }))]);

    const notJson = await engine.fetch(new Request(`${BASE}/orders`, { method: 'POST', body: 'nope' }));
    expect(notJson.status).toBe(400);
    const notJsonError = await envelopeOf(notJson);
    expect(notJsonError.message).toContain('not valid JSON');

    const badShape = await engine.fetch(
      new Request(`${BASE}/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sku: 7 }),
      }),
    );
    expect(badShape.status).toBe(400);
    const badShapeError = await envelopeOf(badShape);
    expect(badShapeError.message).toContain('sku');
  });

  it('runs derivers in order and short-circuits HttpError into the envelope', async () => {
    const secret = route.get('/secret', { id: 'secret', output: z.object({ who: z.string() }) });
    const trace: string[] = [];
    const engine = buildEngine([
      routes()
        .derive('principal', req => {
          trace.push('auth');
          const who = req.headers.get('x-user');
          if (who === null) {
            throw new HttpError(401, HTTP_ERROR_CODES.unauthorized, 'missing or invalid credentials');
          }
          return { who };
        })
        .derive('audit', (_req, ctx) => {
          trace.push(`audit:${ctx.principal.who}`);
          return true;
        })
        .bind(secret, (_input, ctx) => ({ who: ctx.principal.who })),
    ]);

    const denied = await engine.fetch(new Request(`${BASE}/secret`));
    expect(denied.status).toBe(401);
    const deniedError = await envelopeOf(denied);
    expect(deniedError.code).toBe(HTTP_ERROR_CODES.unauthorized);

    const allowed = await engine.fetch(new Request(`${BASE}/secret`, { headers: { 'x-user': 'ada' } }));
    expect(await allowed.json()).toEqual({ who: 'ada' });
    expect(trace).toEqual(['auth', 'auth', 'audit:ada']);
  });

  it('passes raw Responses through untouched', async () => {
    const redirect = route.get('/old', { id: 'old' });
    const engine = buildEngine([routes().bind(redirect, () => Response.redirect(`${BASE}/new`, 308))]);
    const res = await engine.fetch(new Request(`${BASE}/old`));
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`${BASE}/new`);
  });

  it('fails loudly when handler output violates the contract', async () => {
    const strict = route.get('/strict', { id: 'strict', output: z.object({ n: z.number() }) });
    const engine = buildEngine([
      // Runtime contract violation: the erased seam is exactly what this
      // guards — simulate a handler lying about its output.
      routes().bind(strict, () => ({ n: 'not-a-number' }) as unknown as { n: number }),
    ]);
    const res = await engine.fetch(new Request(`${BASE}/strict`));
    expect(res.status).toBe(500);
    const error = await envelopeOf(res);
    expect(error.code).toBe(HTTP_ERROR_CODES.internal);
    expect(error.message).toContain('output schema');
  });

  it('mounts foreign fetch handlers under a stripped prefix', async () => {
    const engine = buildEngine([
      routes().mount('/rpc', req => new Response(new URL(req.url).pathname), { id: 'rpc', transport: 'orpc' }),
    ]);
    const res = await engine.fetch(new Request(`${BASE}/rpc/orders.list`));
    expect(await res.text()).toBe('/orders.list');
  });

  it('emits the coded 404 envelope for unmatched routes', async () => {
    const engine = buildEngine([routes()]);
    const res = await engine.fetch(new Request(`${BASE}/nowhere`));
    expect(res.status).toBe(404);
    const notFoundError = await envelopeOf(res);
    expect(notFoundError.code).toBe(HTTP_ERROR_CODES.notFound);
  });

  it('rejects duplicate method+path across bundles at build time', () => {
    const a = route.get('/dup', { id: 'a' });
    const b = route.get('/dup', { id: 'b' });
    try {
      buildEngine([routes().bind(a, () => new Response('a')), routes().bind(b, () => new Response('b'))]);
      expect.unreachable('duplicate route must throw');
    } catch (error) {
      expect(error).toMatchObject({ code: HTTP_ERROR_CODES.duplicateRoute });
    }
  });

  it('carries HttpError headers onto the wire — the 401 challenge case', async () => {
    const admin = route.get('/admin', { id: 'admin', output: z.object({ ok: z.boolean() }) });
    const engine = buildEngine([
      routes()
        .derive('operator', req => {
          if (req.headers.get('authorization') === null) {
            throw new HttpError(401, HTTP_ERROR_CODES.unauthorized, 'credentials required', {
              headers: { 'www-authenticate': 'Basic realm="admin"' },
            });
          }
          return true;
        })
        .bind(admin, () => ({ ok: true })),
    ]);

    const challenged = await engine.fetch(new Request(`${BASE}/admin`));
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toBe('Basic realm="admin"');
    expect(challenged.headers.get('content-type')).toContain('application/json');
  });

  it('composes middleware first-outermost, with thrown errors mapped to the envelope', async () => {
    const ping = route.get('/ping', { id: 'ping', output: z.object({ ok: z.boolean() }) });
    const engine = buildEngine([routes().bind(ping, () => ({ ok: true }))]);

    const order: string[] = [];
    const fetch = composeMiddleware(engine.fetch, [
      async (req, next) => {
        order.push('outer:in');
        const res = await next(req);
        order.push('outer:out');
        const out = new Response(res.body, res);
        out.headers.set('x-outer', '1');
        return out;
      },
      async (req, next) => {
        order.push('inner:in');
        if (req.headers.get('x-block') !== null) {
          throw new HttpError(403, HTTP_ERROR_CODES.forbidden, 'blocked by middleware');
        }
        return next(req);
      },
    ]);

    const ok = await fetch(new Request(`${BASE}/ping`));
    expect(await ok.json()).toEqual({ ok: true });
    expect(ok.headers.get('x-outer')).toBe('1');
    expect(order).toEqual(['outer:in', 'inner:in', 'outer:out']);

    const blocked = await fetch(new Request(`${BASE}/ping`, { headers: { 'x-block': 'y' } }));
    expect(blocked.status).toBe(403);
    const blockedError = await envelopeOf(blocked);
    expect(blockedError.code).toBe(HTTP_ERROR_CODES.forbidden);
  });

  it('honors inbound x-request-id and exposes the ambient request context', async () => {
    const whoami = route.get('/whoami', { id: 'whoami', output: z.object({ rid: z.string() }) });
    const engine = buildEngine([
      routes().bind(whoami, (_input, ctx) => {
        expect(requestContext()?.requestId).toBe(ctx.requestId);
        return { rid: ctx.requestId };
      }),
    ]);
    const res = await engine.fetch(new Request(`${BASE}/whoami`, { headers: { 'x-request-id': 'req-7' } }));
    expect(await res.json()).toEqual({ rid: 'req-7' });
    expect(requestContext()).toBeUndefined();
  });

  // A route with no derivers and no body runs its handler synchronously; one
  // with either goes through the async path. Both must answer identically.
  describe('sync and async paths answer the same', () => {
    const item = z.object({ id: z.string() });
    const syncGet = route.get('/sync/:id', { id: 'sync', output: item });
    const asyncGet = route.get('/async/:id', { id: 'async', output: item });
    const derivedGet = route.get('/derived/:id', { id: 'derived', output: item });
    const engine = buildEngine([
      routes()
        .bind(syncGet, ({ params }) => {
          if (params.id === 'boom') throw new HttpError(409, HTTP_ERROR_CODES.badRequest, 'nope');
          return { id: params.id };
        })
        .bind(asyncGet, async ({ params }) => {
          await Promise.resolve();
          if (params.id === 'boom') throw new HttpError(409, HTTP_ERROR_CODES.badRequest, 'nope');
          return { id: requestContext()?.requestId === 'r-1' ? params.id : 'lost-context' };
        }),
      routes()
        .derive('tag', () => 'x')
        .bind(derivedGet, ({ params }) => {
          if (params.id === 'boom') throw new HttpError(409, HTTP_ERROR_CODES.badRequest, 'nope');
          return { id: params.id };
        }),
    ]);
    const send = (path: string) => engine.fetch(new Request(`${BASE}${path}`, { headers: { 'x-request-id': 'r-1' } }));

    it('serializes the output with the same body and content type', async () => {
      for (const path of ['/sync/a%20b', '/async/a%20b', '/derived/a%20b']) {
        const res = await send(path);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json');
        expect(await res.text()).toBe('{"id":"a b"}');
      }
    });

    it('maps a sync throw and an async rejection to the same envelope', async () => {
      for (const path of ['/sync/boom', '/async/boom', '/derived/boom']) {
        const res = await send(path);
        expect(res.status).toBe(409);
        expect(await envelopeOf(res)).toMatchObject({ code: HTTP_ERROR_CODES.badRequest, message: 'nope' });
      }
    });
  });

  it('answers 500 when the validated output has no JSON form, like Response.json', async () => {
    const empty = route.get('/empty', { id: 'empty', output: z.unknown() });
    const engine = buildEngine([
      routes().bind(empty, () => {
        // Returns nothing: undefined has no JSON form.
      }),
    ]);
    const res = await engine.fetch(new Request(`${BASE}/empty`));
    expect(res.status).toBe(500);
    const error = await envelopeOf(res);
    expect(error.code).toBe(HTTP_ERROR_CODES.internal);
  });
});
