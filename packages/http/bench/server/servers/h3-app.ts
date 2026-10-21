import { H3 } from 'h3';

import { createItem, NOT_FOUND, ping, user } from './shared.ts';

export function h3App(): H3 {
  const app = new H3();
  app.get('/ping', () => ping());
  app.get('/users/:id', event => user(event.context.params!['id']!));
  app.post('/items', async event => {
    let raw: unknown;
    try { raw = await event.req.json(); } catch { return Response.json({ error: 'not json' }, { status: 400 }); }
    const r = createItem(raw);
    return Response.json(r.body, { status: r.status });
  });
  app.all('/**', () => Response.json(NOT_FOUND.body, { status: 404 }));
  return app;
}
