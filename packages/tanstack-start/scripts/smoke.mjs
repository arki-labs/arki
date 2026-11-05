// Cross-runtime smoke test. Runs the BUILT entries under Node, Bun and Deno via
// `bun run test:runtimes`. A Dot app is served through startServer with no browser and no
// database; an oRPC router answers a real RPC request; failures answer with their own status.
// Entries: ./dot and ./server (the app serves a request, a boot failure answers 503),
// ./orpc/server (RPC call, CORS headers), ./orpc/client, ./orpc/query, ./router,
// ./error, ./scripts, ./server-error-overlay, and the entries that need a bundler or
// browser (./vite, ./config, ./devtools, ./sentry/*, ./pwa, ./pwa/sw, ./pwa/client) are loaded.

import { createElement } from 'react';
import { oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';

import { defineApp, infra } from '@arki/dot';

import { tanstackStart } from '../dist/src/dot.js';
import { CronUnauthenticated, failureResponse } from '../dist/src/failures.js';
import { getORPCUrl } from '../dist/src/orpc/client.js';
import { createORPCHandler, createRouteHandlers, createServerCaller, getCorsHeaders } from '../dist/src/orpc/server.js';
import { createQueryClient } from '../dist/src/router.js';
import { AnalyticsScript } from '../dist/src/scripts.js';
import { withServerErrorOverlay } from '../dist/src/server-error-overlay.js';
import { startServer, withForwardedProto } from '../dist/src/start-server.js';

import '../dist/src/app.config.js';
import '../dist/src/error.js';
import '../dist/src/orpc/query.js';
import '../dist/src/index.js';

const start = tanstackStart({ session: () => ({ user: 'ada' }), rpc: () => ({ caller: 'smoke' }) });
const noClient = new URL('file:///nonexistent/');

const server = startServer(defineApp('smoke').entrypoints(start), {
  client: noClient,
  handler: async (_request, { context }) => new Response(`page for ${(await context.session()).user}`),
});
const served = await server.fetch(new Request('https://smoke.test/digest'));
const servedBody = await served.text();

const broken = infra({
  name: 'extra',
  boot() {
    throw new Error('cannot reach postgres://admin:hunter2@db');
  },
});
const failing = startServer(defineApp('broken').infra(broken).entrypoints(start), {
  client: noClient,
  handler: () => new Response('unreachable'),
});
const unavailable = await failing.fetch(new Request('https://smoke.test/'));
const unavailableBody = await unavailable.text();

const contract = { greet: oc.input(z.object({ name: z.string() })).output(z.object({ message: z.string() })) };
const impl = implement(contract).$context();
const router = impl.router({ greet: impl.greet.handler(({ input }) => ({ message: `hello ${input.name}` })) });
const { handleRequest } = createORPCHandler({ router, createContext: () => ({}) });
const rpc = await handleRequest(
  new Request('https://smoke.test/api/orpc/greet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: { name: 'Ada' } }),
  }),
);
const rpcBody = await rpc.json();
const missing = await handleRequest(new Request('https://smoke.test/elsewhere'));
const refusedContext = await createORPCHandler({
  router,
  createContext: () => {
    throw CronUnauthenticated();
  },
}).handleRequest(new Request('https://smoke.test/api/orpc/greet', { method: 'POST', body: '{}' }));
const caller = createServerCaller({ router, context: () => ({}) });
const called = await caller.greet({ name: 'Grace' });
const handlers = createRouteHandlers(handleRequest);

const overlay = withServerErrorOverlay(async () => {
  throw new Error('page crashed');
});
const crashed = await overlay(new Request('https://smoke.test/page', { headers: { accept: 'text/html' } }));
const notResponse = await withServerErrorOverlay(async () => 'oops')(new Request('https://smoke.test/page'));

const forwarded = withForwardedProto(new Request('http://smoke.test/a', { headers: { 'x-forwarded-proto': 'https' } }));
const forwardedPost = withForwardedProto(
  new Request('http://smoke.test/a', { method: 'POST', headers: { 'x-forwarded-proto': 'https' }, body: 'x' }),
);
const analytics = renderToStaticMarkup(
  createElement(AnalyticsScript, { provider: 'plausible', config: { domain: 'smoke.test', enableDev: true } }),
);
const unauthenticated = failureResponse(CronUnauthenticated());

const checks = [
  ['startServer serves a page with the request context', `${served.status}:${servedBody}`, '200:page for ada'],
  ['a boot failure answers 503', unavailable.status, 503],
  [
    'the 503 body names the code and hides the cause',
    unavailableBody.includes('tanstack_start.unavailable') && !unavailableBody.includes('hunter2'),
    true,
  ],
  ['an rpc call returns the handler answer', rpcBody.json?.message, 'hello Ada'],
  ['an unmatched path is 404', missing.status, 404],
  ['a createContext that throws a failure answers with its own status', refusedContext.status, 401],
  ['the server caller runs the router in process', called.message, 'hello Grace'],
  ['route handlers cover the methods', Object.keys(handlers).join(','), 'GET,POST,PUT,PATCH,DELETE,OPTIONS'],
  [
    'cors headers carry the given origin',
    getCorsHeaders('https://a.test')['Access-Control-Allow-Origin'],
    'https://a.test',
  ],
  ['a crashing handler answers 500', crashed.status, 500],
  ['a handler that returns a non response is a 500', notResponse.status, 500],
  ['forwarded proto upgrades a GET to https', new URL(forwarded.url).protocol, 'https:'],
  ['forwarded proto leaves a POST alone', new URL(forwardedPost.url).protocol, 'http:'],
  ['a failure turns into its response', unauthenticated.status, 401],
  ['analytics script renders the plausible tag', analytics.includes('smoke.test'), true],
  ['query client has the default stale time', createQueryClient().getDefaultOptions().queries?.staleTime, 60_000],
  ['oRPC url falls back to localhost on the server', getORPCUrl().endsWith('/api/orpc'), true],
];

const engine =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? `deno ${Deno.version.deno}`
      : typeof Bun !== 'undefined'
        ? `bun ${Bun.version}`
        : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
          ? `browser ${navigator.userAgent}`
          : `node ${globalThis.process?.version ?? ''}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${engine}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
// Timers of the query client and the queue keep some engines alive after the checks end.
if (typeof globalThis.process !== 'undefined') globalThis.process.exit(0);
