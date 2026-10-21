// Request dispatch: @arki/http (its default compiled engine, and its Hono engine) against hono and itty-router.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Every row receives a real `Request` and returns a `Response`, in process.
// `run` builds the Request, dispatches it and reads the body, so every row
// pays for the same Request and Response work. The contract check compares
// status and body text before timing.

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { json, Router } from 'itty-router';
import { z } from 'zod';

import type { CaseBuilder, CaseSpec } from '@arki/bench';
import { compare, defineSuite, scenario } from '@arki/bench';
import { buildEngine, buildHonoEngine, route, routes } from '@arki/http';

const BASE = 'http://localhost';

const Item = z.object({ id: z.string(), name: z.string() });
const NewItem = z.object({ name: z.string().min(1), qty: z.number().int().positive(), tags: z.array(z.string()) });
const Created = z.object({ ok: z.boolean(), name: z.string() });

// 20 routes: 8 static GET, 8 path-parameter GET, 4 POST with a JSON body.
const statics = Array.from({ length: 8 }, (_, index) => `/static${index}`);
const params = Array.from({ length: 8 }, (_, index): `/res${number}/:id` => `/res${index}/:id`);
const posts = Array.from({ length: 4 }, (_, index) => `/create${index}`);

// ---- @arki/http: contracts as data, handlers bound to them. Both engines serve the same bundles.
const arkiBundles = [
  ...statics.map((path, index) =>
    routes().bind(route.get(path, { id: `static.${index}`, output: z.object({ ok: z.boolean() }) }), () => ({
      ok: true,
    })),
  ),
  ...params.map((path, index) =>
    routes().bind(route.get(path, { id: `res.${index}`, output: Item }), ({ params: p }) => ({
      id: p.id,
      name: 'item',
    })),
  ),
  ...posts.map((path, index) =>
    routes().bind(route.post(path, { id: `create.${index}`, body: NewItem, output: Created }), ({ body }) => ({
      ok: true,
      name: body.name,
    })),
  ),
];
const arki = buildEngine(arkiBundles);
const arkiHono = buildHonoEngine(arkiBundles);

// ---- hono: routes registered by hand, body validated with @hono/zod-validator.
const hono = new Hono();
for (const path of statics) hono.get(path, c => c.json({ ok: true }));
for (const path of params) hono.get(path, c => c.json({ id: c.req.param('id'), name: 'item' }));
for (const path of posts)
  hono.post(path, zValidator('json', NewItem), c => c.json({ ok: true, name: c.req.valid('json').name }));

// ---- itty-router: routes by hand, body validated by hand with the same schema.
// itty-router v5 does not percent-decode path parameters, so the handler decodes by hand.
const itty = Router();
for (const path of statics) itty.get(path, () => json({ ok: true }));
for (const path of params)
  itty.get(path, ({ params: p }) => json({ id: decodeURIComponent(p['id'] ?? ''), name: 'item' }));
for (const path of posts) {
  itty.post(path, async (request: Request) => {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ error: 'not json' }, { status: 400 });
    }
    const parsed = NewItem.safeParse(raw);
    if (!parsed.success) return json({ error: parsed.error.message }, { status: 400 });
    return json({ ok: true, name: parsed.data.name });
  });
}

/** One request: a path, and a JSON body for POST. */
type Call = { path: string; body?: string };

function toRequest({ path, body }: Call): Request {
  if (body === undefined) return new Request(`${BASE}${path}`);
  return new Request(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
}

// `run` reads the body itself and returns "<status> <body text>": serving a
// request includes producing its body, and every row does the same work.
async function reply(response: Promise<Response>): Promise<string> {
  const res = await response;
  return `${res.status} ${await res.text()}`;
}
const post = (value: unknown): Call => ({ path: '/create2', body: JSON.stringify(value) });

/** The three routers, each answering one call with "<status> <body text>". */
const routers = {
  arki: {
    label: '@arki/http (compiled engine, the default)',
    package: '@arki/http',
    send: (call: Call) => reply(arki.fetch(toRequest(call))),
  },
  arkiHono: {
    label: '@arki/http (Hono engine)',
    package: '@arki/http',
    send: (call: Call) => reply(arkiHono.fetch(toRequest(call))),
  },
  hono: {
    label: 'hono (+ @hono/zod-validator)',
    package: 'hono',
    send: (call: Call) => reply(Promise.resolve(hono.fetch(toRequest(call)))),
  },
  itty: {
    label: 'itty-router v5 (hand-written validation)',
    package: 'itty-router',
    send: (call: Call) => reply(itty.fetch(toRequest(call))),
  },
};

/** The same three rows for every ranked group. */
function rows(c: CaseBuilder<Call>): Record<string, CaseSpec<Call, unknown, unknown>> {
  return {
    arki: c({ label: routers.arki.label, package: routers.arki.package, run: routers.arki.send }),
    arkiHono: c({ label: routers.arkiHono.label, package: routers.arkiHono.package, run: routers.arkiHono.send }),
    hono: c({ label: routers.hono.label, package: routers.hono.package, run: routers.hono.send }),
    itty: c({ label: routers.itty.label, package: routers.itty.package, run: routers.itty.send }),
  };
}

// Invalid bodies: every router answers 400, each with its own body, so the
// group is a scenario. Without a contract check, the status is checked here.
const invalidCalls: Call[] = [
  post({ name: '', qty: -1, tags: 'x' }),
  post({ name: 'w', qty: 1.5, tags: [] }),
  post({}),
  { path: '/create2', body: '{not json' },
];
for (const call of invalidCalls) {
  for (const [key, router] of Object.entries(routers)) {
    const answer = await router.send(call);
    if (!answer.startsWith('400 '))
      throw new Error(`${key} answered ${answer.slice(0, 80)} to ${call.body}, wanted 400`);
  }
}

export default defineSuite({
  id: '@arki/http',
  intro:
    'Each router receives a real `Request` and returns a `Response`, in process, with no network. `@arki/http` rows are the same package on its two engines: the default compiled router (hono behind it for what it does not match) and hono alone. hono is the direct reference; itty-router is the small, hand-wired alternative. All four serve the same 20 routes and validate bodies with the same zod schema. Each table only ranks routers that returned the same status and body on every checked request.',
  notes: [
    'The gap from `@arki/http` to plain hono is the price of the contract layer: every handler input (params, query, body) is validated against its contract, and every handler output is validated against the contract output schema, so a wrong response fails loudly instead of leaving the process.',
    'The hono and itty-router rows do not validate handler output and have no route ids, no error envelope and no OpenAPI generation. Their `Request` and `Response` work is the same.',
    'itty-router has no validation hook, so its rows parse the JSON and run the zod schema by hand, the way its docs suggest. itty-router v5 also leaves path parameters percent-encoded (`caf%C3%A9`); its row decodes them by hand so it returns the same id as the others.',
    'Every row builds the `Request` and reads the response body inside the timed call.',
  ],
  groups: [
    compare<Call>({
      id: 'static-get',
      title: 'Static GET (one of 20 routes)',
      contract: { id: 'http-static-get/v1', description: 'status 200 and the body {"ok":true}' },
      inputs: [{ path: '/static0' }, { path: '/static5' }, { path: '/static7' }],
      expected: () => '200 {"ok":true}',
      baseline: 'arki',
      mode: 'async',
      cases: c => rows(c),
    }),
    compare<Call>({
      id: 'param-get',
      title: 'GET with a path parameter',
      contract: {
        id: 'http-param-get/v1',
        description: 'status 200 and {"id":<the decoded path parameter>,"name":"item"} (caf%C3%A9 → café)',
      },
      inputs: [
        { path: '/res0/abc123' },
        { path: '/res6/caf%C3%A9' },
        { path: '/res3/a%20b' },
        { path: `/res7/${'x'.repeat(64)}` },
      ],
      expected: ({ path }) =>
        `200 ${JSON.stringify({ id: decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)), name: 'item' })}`,
      baseline: 'arki',
      mode: 'async',
      cases: c => rows(c),
    }),
    compare<Call>({
      id: 'post-valid',
      title: 'POST with a valid JSON body',
      note: 'Body parsed and checked with the same zod schema in every row. `@arki/http` also checks the output.',
      contract: {
        id: 'http-post-valid/v1',
        description: 'status 200 and {"ok":true,"name":<the body name>} for a body the schema accepts',
      },
      inputs: [
        post({ name: 'widget', qty: 3, tags: ['a', 'b'] }),
        post({ name: 'Zoë 雪', qty: 1, tags: [] }),
        post({ name: 'w', qty: 2, tags: [], extra: true }),
        post({ name: 'many tags', qty: 9999, tags: Array.from({ length: 20 }, (_, index) => `t${index}`) }),
      ],
      expected: ({ body }) =>
        `200 ${JSON.stringify({ ok: true, name: (JSON.parse(body ?? '{}') as { name: string }).name })}`,
      baseline: 'arki',
      mode: 'async',
      cases: c => rows(c),
    }),
    scenario({
      id: 'post-invalid',
      title: 'POST with an invalid body (400)',
      note: 'The failure path. Every row answers 400, checked before timing, but with a different body: `@arki/http` builds its error envelope `{"error":{"code":"ARKI_HTTP_E400","message":…}}` naming each failed field; hono answers `{"success":false,"error":<ZodError>}` (plain text for malformed JSON); itty answers a hand-written `{"error":<zod issues>}`. Different work, so no ratios.',
      inputs: invalidCalls,
      mode: 'async',
      cases: {
        arki: { label: routers.arki.label, package: routers.arki.package, run: routers.arki.send },
        hono: { label: routers.hono.label, package: routers.hono.package, run: routers.hono.send },
        itty: { label: routers.itty.label, package: routers.itty.package, run: routers.itty.send },
      },
    }),
  ],
});
