import { createServer } from 'node:http';
import { createItem, NOT_FOUND, ping, PORT, ready, user } from './shared.ts';
const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};
createServer((req, res) => {
  const path = req.url ?? '/';
  if (req.method === 'GET') {
    if (path === '/ping') return send(res, 200, ping());
    if (path.startsWith('/users/')) return send(res, 200, user(decodeURIComponent(path.slice(7))));
  } else if (req.method === 'POST' && path === '/items') {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let raw: unknown;
      try { raw = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(res, 400, { error: 'not json' }); }
      const r = createItem(raw);
      send(res, r.status, r.body);
    });
    return;
  }
  send(res, 404, NOT_FOUND.body);
}).listen(PORT, '127.0.0.1', ready);
