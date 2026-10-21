// @arki/http as shipped: the compiled engine; `listen` hands Bun its route table.
import { buildEngine, listen, route, routes } from '@arki/http';
import { z } from 'zod';

import { NewItem, ping, PORT, ready, user } from './shared.ts';

export const bundles = [
  routes()
    .bind(route.get('/ping', { id: 'ping', output: z.object({ ok: z.boolean() }) }), () => ping())
    .bind(
      route.get('/users/:id', { id: 'users.get', params: { id: z.string() }, output: z.object({ id: z.string(), name: z.string() }) }),
      ({ params }) => user(params.id),
    )
    .bind(
      route.post('/items', { id: 'items.create', body: NewItem, output: z.object({ ok: z.boolean(), name: z.string() }) }),
      ({ body }) => ({ ok: true, name: body.name }),
    ),
];

if (import.meta.main) {
  await listen(buildEngine(bundles), { port: PORT, hostname: '127.0.0.1' });
  ready();
}
