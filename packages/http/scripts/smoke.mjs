// Cross-runtime smoke test for the typed client. Runs the BUILT client entry
// (dist/client.js) under Node, Bun and Deno via `bun run test:runtimes`, and is
// bundled for the browser and Hermes targets. It imports only the client entry:
// the root entry is the server and loads `node:async_hooks`. The fake `fetch`
// returns a minimal response object, because Hermes has no `Response`.

import { z } from 'zod';

import { defineFailure, isFailure } from '@arki/failure';

import { createClient } from '../dist/client.js';

const isoDate = z.codec(z.iso.datetime(), z.date(), {
  decode: text => new Date(text),
  encode: date => date.toISOString(),
});

// Contracts are plain data; the client reads kind, id, method, path and schemas.
const moveEvent = {
  kind: 'http',
  id: 'events.move',
  method: 'POST',
  path: '/events/:id/move',
  query: z.object({ since: isoDate.optional() }),
  body: z.object({ at: isoDate }),
  output: z.object({ id: z.string(), at: isoDate }),
};
const lockEvent = { kind: 'http', id: 'events.lock', method: 'DELETE', path: '/events/:id' };
const EventNotFound = defineFailure('event.not_found', {
  status: 404,
  data: z.object({ id: z.string() }),
  message: 'no event {id}',
});
const getEvent = {
  kind: 'http',
  id: 'events.get',
  method: 'GET',
  path: '/events/:id',
  output: z.object({ id: z.string() }),
  failures: [EventNotFound],
};

/** A fake server: records each request, answers with what `answer` returns. */
function fakeFetch(answer) {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, init });
    const { status, body } = answer(url, init);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetch, sent };
}

async function outcome(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

async function main() {
  // The server echoes the moved event with the body's ISO string.
  const echo = fakeFetch((url, init) => ({ status: 200, body: { id: 'e1', at: JSON.parse(init.body).at } }));
  const events = createClient({ moveEvent, lockEvent }, { baseUrl: 'https://api.test/', fetch: echo.fetch });
  const moved = await events.moveEvent({
    params: { id: 'a b/c' },
    query: { since: new Date(1000) },
    body: { at: new Date(5000) },
  });

  const locked = fakeFetch(() => ({
    status: 403,
    body: { error: { code: 'ARKI_HTTP_E403', message: 'events are locked', remediation: 'Ask an admin.' } },
  }));
  const denied = await outcome(
    createClient(lockEvent, { baseUrl: 'https://api.test', fetch: locked.fetch })({ params: { id: 'e1' } }),
  );

  const unused = fakeFetch(() => ({ status: 200, body: {} }));
  const invalid = await outcome(
    createClient(moveEvent, { baseUrl: 'https://api.test', fetch: unused.fetch })({
      params: { id: 'e1' },
      body: { at: new Date('yesterday') },
    }),
  );

  const missing = fakeFetch(() => ({
    status: 404,
    body: { error: { code: 'event.not_found', message: 'no event e9', data: { id: 'e9' } } },
  }));
  const notFound = await createClient(getEvent, { baseUrl: 'https://api.test', fetch: missing.fetch })({
    params: { id: 'e9' },
  });

  const traversal = fakeFetch(() => ({ status: 200, body: {} }));
  const escaped = await outcome(
    createClient(lockEvent, { baseUrl: 'https://api.test', fetch: traversal.fetch })({ params: { id: '..' } }),
  );

  // A minimal retry policy, the shape @arki/resilience provides: one retry on a throw.
  const oneRetry = {
    execute: async fn => {
      try {
        return await fn({ signal: undefined });
      } catch {
        return fn({ signal: undefined });
      }
    },
  };
  let busyOnce = true;
  const flaky = fakeFetch(() => {
    const status = busyOnce ? 503 : 200;
    busyOnce = false;
    return status === 503
      ? { status, body: { error: { code: 'ARKI_HTTP_E500', message: 'busy' } } }
      : { status, body: { id: 'e1' } };
  });
  const retried = await createClient(getEvent, { baseUrl: 'https://api.test', fetch: flaky.fetch, policy: oneRetry })({
    params: { id: 'e1' },
  });

  // timeoutMs needs AbortController: React Native provides it; bare Hermes does not.
  const hanging = (url, init) =>
    new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const timedOut =
    typeof AbortController === 'undefined'
      ? { error: { code: 'ARKI_HTTP_E408' } }
      : await outcome(
          createClient(getEvent, { baseUrl: 'https://api.test', fetch: hanging, timeoutMs: 10 })({
            params: { id: 'e1' },
          }),
        );

  const checks = [
    ['output decodes to a Date', moved.at instanceof Date && moved.at.getTime(), 5000],
    ['body encodes the Date as ISO', echo.sent[0].init.body, '{"at":"1970-01-01T00:00:05.000Z"}'],
    [
      'params escaped, query encoded',
      echo.sent[0].url,
      'https://api.test/events/a%20b%2Fc/move?since=1970-01-01T00%3A00%3A01.000Z',
    ],
    ['JSON content type', echo.sent[0].init.headers['content-type'], 'application/json'],
    ['envelope becomes HttpError', denied.error && denied.error.name, 'HttpError'],
    ['server code kept', denied.error && denied.error.code, 'ARKI_HTTP_E403'],
    ['server status kept', denied.error && denied.error.status, 403],
    ['bad input is E400', invalid.error && invalid.error.code, 'ARKI_HTTP_E400'],
    ['bad input never sent', unused.sent.length, 0],
    ['listed failure is revived, not thrown', isFailure(notFound) && EventNotFound.is(notFound), true],
    ['revived failure keeps its data', notFound.data && notFound.data.id, 'e9'],
    ['".." path param is E400', escaped.error && escaped.error.code, 'ARKI_HTTP_E400'],
    ['".." path param never sent', traversal.sent.length, 0],
    ['a 503 GET is retried through the policy', flaky.sent.length, 2],
    ['the retried call decodes the success', retried.id, 'e1'],
    ['timeoutMs rejects with E408', timedOut.error && timedOut.error.code, 'ARKI_HTTP_E408'],
  ];

  let failedChecks = 0;
  for (const [name, actual, expected] of checks) {
    if (actual === expected) continue;
    failedChecks++;
    console.log(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  const runtime =
    typeof HermesInternal !== 'undefined'
      ? 'hermes'
      : typeof Deno !== 'undefined'
        ? 'deno'
        : typeof Bun !== 'undefined'
          ? 'bun'
          : typeof window !== 'undefined'
            ? 'browser'
            : 'node';
  if (failedChecks > 0) {
    console.log(`${runtime}: ${failedChecks} smoke checks FAILED`);
    throw new Error('smoke failed');
  }
  console.log(`${runtime}: ${checks.length} smoke checks passed`);
}

main();
