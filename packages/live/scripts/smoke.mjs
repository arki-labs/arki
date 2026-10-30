// Cross-runtime smoke test. Runs the BUILT entries (dist/index.js,
// dist/testing.js, dist/react.js) under Node and Bun, and as a bundle under
// Deno, headless Chromium and Hermes, via `bun run test:runtimes`. No database:
// it proves the schemas, `live()`, `affectedPaths`, the stream client and the
// React entry load and run everywhere. The hub needs WebCrypto to seal its
// cursors; where `crypto.subtle` is missing (bare Hermes) its start must fail loud.

import { QueryClient } from '@tanstack/react-query';

import {
  affectedPaths,
  createLiveClient,
  createLiveHub,
  live,
  LIVE_ERROR_CODES,
  liveReceipts,
  liveTables,
  parseLiveCursor,
  parseLiveEvent,
} from '../dist/index.js';
import { LiveProvider, setLiveCursor, useLiveQuery } from '../dist/react.js';
import { fakeSource } from '../dist/testing.js';

const posts = { schema: 'public', table: 'posts' };
const refuses = fn => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const manifest = [
  { path: ['posts', 'list'], reads: [posts] },
  { path: ['users', 'count'], reads: [{ schema: 'public', table: 'users' }] },
];

const hubChecks = [];
const source = fakeSource();
const hub = createLiveHub({ source, limits: { batchMs: 1 } });
if (globalThis.crypto?.subtle) {
  await hub.start();
  source.emit({ kind: 'ready' });
  const stream = (await hub.open({ signal: new AbortController().signal }))[Symbol.asyncIterator]();
  const begin = (await stream.next()).value;
  source.emit({ kind: 'change', tags: [posts, posts] });
  const change = (await stream.next()).value;
  source.emit({ kind: 'gap' });
  const gap = (await stream.next()).value;
  await hub.stop();
  hubChecks.push(
    ['first connect resets', `${begin.kind}:${begin.mode}`, 'begin:reset'],
    ['opaque cursor', parseLiveCursor(begin.cursor)?.length, 75],
    [
      'change frame is a wire event',
      parseLiveEvent({ kind: change.kind, cursor: change.cursor, tags: change.tags, txids: change.txids })?.kind,
      'change',
    ],
    ['change tags unioned', change.tags.length, 1],
    ['gap ends the stream', gap.kind, 'gap'],
    ['stopped', hub.status(), 'stopped'],
  );
  const receipts = liveReceipts({ app: 'smoke', secret: 'smoke-test-secret-of-32-characters-0' });
  const receipt = await receipts.of('9007199254740993');
  hubChecks.push(
    ['a receipt is 22 base64url characters', /^[\w-]{22}$/.test(receipt), true],
    ['one secret, one receipt', (await receipts.of('9007199254740993')) === receipt, true],
  );
} else {
  const refused = await hub.start().then(
    () => 'started',
    error => error.code,
  );
  hubChecks.push(['a hub without WebCrypto fails loud at start', refused, LIVE_ERROR_CODES.config]);
  const receiptsRefused = refuses(() => liveReceipts({ app: 'smoke', secret: 'smoke-test-secret-of-32-characters-0' }));
  hubChecks.push(['receipts without WebCrypto fail loud at once', receiptsRefused, true]);
}

// The stream client, where the engine has streaming fetch primitives (bare Hermes has none).
const clientChecks = [];
if (typeof ReadableStream === 'function' && typeof Response === 'function' && typeof TextDecoder === 'function') {
  const hello = { kind: 'hello', v: 1, mode: 'reset', cursor: 'c'.repeat(64), manifest: [] };
  const bytes = new TextEncoder().encode(`:keepalive\n\ndata: ${JSON.stringify(hello)}\n\n`);
  const fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 9));
            controller.enqueue(bytes.slice(9));
          },
        }),
      ),
    );
  const received = await new Promise(resolve => {
    const client = createLiveClient({
      url: '/api/live',
      fetch,
      onEvent: event => {
        client.stop();
        resolve(event.kind);
      },
    });
    client.start();
  });
  clientChecks.push(['client reads a split frame', received, 'hello']);
}

const queryClient = new QueryClient();
setLiveCursor(queryClient, 'c'.repeat(64));

const checks = [
  ...hubChecks,
  ...clientChecks,
  ['react entry loads', typeof LiveProvider === 'function' && typeof useLiveQuery === 'function', true],
  ['setLiveCursor seeds the cache', queryClient.getQueryData(['@arki/live', 'cursor'])?.length, 64],
  [
    'live() refuses a 64-byte name',
    refuses(() => live({ reads: [{ schema: 'public', table: 'é'.repeat(32) }] })),
    true,
  ],
  [
    'live() dedupes',
    JSON.stringify(live({ reads: [posts, posts] })),
    '{"live":{"version":1,"reads":[{"schema":"public","table":"posts"}]}}',
  ],
  ['affectedPaths', JSON.stringify(affectedPaths(manifest, [posts])), '[["posts","list"]]'],
  [
    'liveTables',
    JSON.stringify(liveTables([...manifest, { path: ['stats'], reads: [posts] }]).map(t => t.table)),
    '["posts","users"]',
  ],
  ['malformed cursor', parseLiveCursor('nope').code, 'schema.invalid_input'],
  ['not a wire event', parseLiveEvent({ kind: 'change' }).code, 'schema.invalid_input'],
];

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed += 1;
    console.log(`FAIL ${name}: expected ${String(expected)}, got ${String(actual)}`);
  }
}
if (failed > 0) throw new Error(`${failed} smoke checks failed`);
console.log(`${checks.length} smoke checks passed`);
