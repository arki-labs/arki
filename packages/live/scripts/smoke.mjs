// Cross-runtime smoke test. Runs the BUILT portable entries (dist/index.js,
// dist/testing.js) under Node and Bun, and as a bundle under Deno, headless
// Chromium and Hermes, via `bun run test:runtimes`. No database and no peers:
// it proves the schemas, `live()`, `affectedPaths` and the hub run everywhere.

import {
  affectedPaths,
  createLiveHub,
  live,
  liveCursorSchema,
  liveEventSchema,
  tableTagSchema,
} from '../dist/index.js';
import { fakeSource } from '../dist/testing.js';

const posts = { schema: 'public', table: 'posts' };
const manifest = [
  { path: ['posts', 'list'], reads: [posts] },
  { path: ['users', 'count'], reads: [{ schema: 'public', table: 'users' }] },
];

const source = fakeSource();
const hub = createLiveHub({ source, limits: { batchMs: 1 } });
await hub.start();
source.emit({ kind: 'ready' });
const stream = hub.open({ signal: new AbortController().signal })[Symbol.asyncIterator]();
const begin = (await stream.next()).value;
source.emit({ kind: 'change', tags: [posts, posts] });
const change = (await stream.next()).value;
source.emit({ kind: 'gap' });
const gap = (await stream.next()).value;
await hub.stop();

const checks = [
  ['tag schema accepts a table', tableTagSchema.safeParse(posts).success, true],
  ['tag schema refuses 64 bytes', tableTagSchema.safeParse({ schema: 'public', table: 'é'.repeat(32) }).success, false],
  [
    'live() dedupes',
    JSON.stringify(live({ reads: [posts, posts] })),
    '{"live":{"version":1,"reads":[{"schema":"public","table":"posts"}]}}',
  ],
  ['affectedPaths', JSON.stringify(affectedPaths(manifest, [posts])), '[["posts","list"]]'],
  ['first connect resets', `${begin.kind}:${begin.mode}`, 'begin:reset'],
  ['cursor shape', liveCursorSchema.safeParse(begin.cursor).success, true],
  ['change frame is a wire event', liveEventSchema.safeParse(change).success, true],
  ['change tags unioned', change.tags.length, 1],
  ['gap ends the stream', gap.kind, 'gap'],
  ['stopped', hub.status(), 'stopped'],
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
