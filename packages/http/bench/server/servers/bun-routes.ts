import { createItem, JSON_HEADERS, NOT_FOUND, ping, PORT, ready, user } from './shared.ts';
Bun.serve({
  port: PORT,
  routes: {
    '/ping': new Response(JSON.stringify(ping()), { headers: JSON_HEADERS }),
    '/users/:id': req => Response.json(user(req.params.id)),
    '/items': {
      POST: async req => {
        let raw: unknown;
        try { raw = await req.json(); } catch { return Response.json({ error: 'not json' }, { status: 400 }); }
        const r = createItem(raw);
        return Response.json(r.body, { status: r.status });
      },
    },
  },
  fetch: () => Response.json(NOT_FOUND.body, { status: 404 }),
});
ready();
