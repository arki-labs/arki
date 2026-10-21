import { Hono } from 'hono';

import { createItem, NOT_FOUND, ping, user } from './shared.ts';

export function honoApp(): Hono {
  const app = new Hono();
  app.get('/ping', c => c.json(ping()));
  app.get('/users/:id', c => c.json(user(c.req.param('id'))));
  app.post('/items', async c => {
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: 'not json' }, 400); }
    const r = createItem(raw);
    return c.json(r.body, r.status as 200);
  });
  app.notFound(c => c.json(NOT_FOUND.body, 404));
  return app;
}
