import { createItem, JSON_HEADERS, NOT_FOUND, ping, PORT, ready, user } from './shared.ts';
const notFound = () => Response.json(NOT_FOUND.body, { status: 404 });
Bun.serve({
  port: PORT,
  fetch(req) {
    const url = req.url;
    const path = url.slice(url.indexOf('/', url.indexOf('//') + 2));
    if (req.method === 'GET') {
      if (path === '/ping') return new Response(JSON.stringify(ping()), { headers: JSON_HEADERS });
      if (path.startsWith('/users/')) return Response.json(user(decodeURIComponent(path.slice(7))));
    } else if (req.method === 'POST' && path === '/items') {
      return req.json().then(
        raw => { const r = createItem(raw); return Response.json(r.body, { status: r.status }); },
        () => Response.json({ error: 'not json' }, { status: 400 }),
      );
    }
    return notFound();
  },
});
ready();
