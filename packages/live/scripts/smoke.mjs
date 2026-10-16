// Cross-runtime smoke test. Runs the BUILT portable entries (dist/index.js,
// dist/testing.js) under Node and Bun, and as a bundle under Deno, headless
// Chromium and Hermes, via `bun run test:runtimes`. No database and no peers:
// it proves the schemas, `live()`, `affectedPaths` and the hub run everywhere.

import { affectedPaths, createLiveHub, live, liveTables, parseLiveCursor, parseLiveEvent } from '../dist/index.js';
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
  ['first connect resets', `${begin.kind}:${begin.mode}`, 'begin:reset'],
  ['cursor shape', parseLiveCursor(begin.cursor), begin.cursor],
  ['malformed cursor', parseLiveCursor('nope'), undefined],
  [
    'change frame is a wire event',
    parseLiveEvent({ kind: change.kind, cursor: change.cursor, tags: change.tags, txids: change.txids })?.kind,
    'change',
  ],
  ['not a wire event', parseLiveEvent({ kind: 'change' }), undefined],
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
