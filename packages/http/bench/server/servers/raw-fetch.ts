import { createItem, NOT_FOUND, ping, user } from './shared.ts';

/** Plain fetch handler with hand-rolled routing — the "no framework" ceiling for fetch adapters. */
export function rawFetch(req: Request): Response | Promise<Response> {
  const url = req.url;
  const path = url.slice(url.indexOf('/', url.indexOf('//') + 2));
  if (req.method === 'GET') {
    if (path === '/ping') return Response.json(ping());
    if (path.startsWith('/users/')) return Response.json(user(decodeURIComponent(path.slice(7))));
  } else if (req.method === 'POST' && path === '/items') {
    return req.json().then(
      raw => { const r = createItem(raw); return Response.json(r.body, { status: r.status }); },
      () => Response.json({ error: 'not json' }, { status: 400 }),
    );
  }
  return Response.json(NOT_FOUND.body, { status: 404 });
}
