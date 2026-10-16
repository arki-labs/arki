// Server smoke test. Runs the BUILT root entry (dist/index.js) under Node and
// Bun through `engine.fetch`, with no socket: params, headers, per-status
// replies, 204, and the E510 rejection of a Response without raw().
// Run: `node scripts/server-smoke.mjs` and `bun scripts/server-smoke.mjs`.

import { z } from 'zod';

import { buildEngine, raw, reply, route, routes } from '../dist/index.js';

const runtime = typeof Bun === 'undefined' ? 'node' : 'bun';
const failures = [];
const check = (name, ok) => {
  if (!ok) failures.push(name);
};

const getItem = route.get('/items/:id', {
  id: 'items.get',
  params: { id: z.string().regex(/^\d+$/) },
  headers: { 'x-tenant': z.string() },
  output: z.object({ tenant: z.string(), id: z.string() }),
  responses: { 410: z.object({ reason: z.string() }) },
});
const dropItem = route.delete('/items/:id', { id: 'items.delete' });
const file = route.get('/file', { id: 'file', output: raw({ contentType: 'text/plain' }) });
const leaky = route.get('/leaky', { id: 'leaky' });

const engine = buildEngine([
  routes()
    .bind(getItem, ({ params, headers }) =>
      params.id === '0' ? reply(410, { reason: 'gone' }) : { tenant: headers['x-tenant'], id: params.id },
    )
    .bind(dropItem, () => {})
    .bind(file, () => new Response('bytes'))
    .bind(leaky, () => new Response('oops')),
]);

const ask = (path, init) => engine.fetch(new Request(`http://smoke.local${path}`, init));
const headers = { 'x-tenant': 't1', accept: '*/*' };

const ok = await ask('/items/7', { headers });
check('params and headers reach the handler', ok.status === 200 && (await ok.json()).tenant === 't1');
check('a bad param answers 400', (await ask('/items/x', { headers })).status === 400);
check('a missing header answers 400', (await ask('/items/7')).status === 400);
const gone = await ask('/items/0', { headers });
check('a declared reply status is served', gone.status === 410 && (await gone.json()).reason === 'gone');
const dropped = await ask('/items/7', { method: 'DELETE' });
check('no output answers 204 with an empty body', dropped.status === 204 && (await dropped.text()) === '');
check('raw() passes the Response through', (await (await ask('/file')).text()) === 'bytes');
process.env.NODE_ENV = 'production';
const leaked = await ask('/leaky');
check('a Response without raw() answers 500 E510 in production', leaked.status === 500 && (await leaked.json()).error.code === 'ARKI_HTTP_E510');

if (failures.length > 0) {
  console.log(`${runtime}: server smoke FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`${runtime}: server smoke checks passed`);
