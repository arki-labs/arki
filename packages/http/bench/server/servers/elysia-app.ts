import { Elysia, t } from 'elysia';

import { NewItem, NOT_FOUND, ping, user } from './shared.ts';

/** Elysia with the SAME zod schema via Standard Schema (fair comparison). */
export function elysiaApp(options?: ConstructorParameters<typeof Elysia>[0]) {
  return new Elysia(options)
    .onError(({ code, set }) => { if (code === 'VALIDATION') { set.status = 400; return { error: 'invalid' }; } if (code === 'NOT_FOUND') { set.status = 404; return NOT_FOUND.body; } })
    .get('/ping', () => ping())
    .get('/users/:id', ({ params }) => user(params.id))
    .post('/items', ({ body }) => ({ ok: true, name: body.name }), { body: NewItem });
}

/** Elysia with its native TypeBox schema (its advertised fast path). */
export function elysiaTypeboxApp(options?: ConstructorParameters<typeof Elysia>[0]) {
  return new Elysia(options)
    .onError(({ code, set }) => { if (code === 'VALIDATION') { set.status = 400; return { error: 'invalid' }; } if (code === 'NOT_FOUND') { set.status = 404; return NOT_FOUND.body; } })
    .get('/ping', () => ping())
    .get('/users/:id', ({ params }) => user(params.id))
    .post('/items', ({ body }) => ({ ok: true, name: body.name }), {
      body: t.Object({ name: t.String({ minLength: 1 }), qty: t.Integer({ minimum: 1 }), tags: t.Array(t.String()) }),
    });
}
