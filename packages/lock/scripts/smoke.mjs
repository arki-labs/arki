// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser target.
// It exercises one call per path; the unit tests cover the details.

import { createLocks } from '../dist/index.js';
import { memoryStore } from '../dist/memory.js';

const locks = createLocks({ store: memoryStore(), namespace: 'smoke' });

const attempt = await locks.mutex('smoke:try').tryRun(async () => 'ok');
if (attempt !== 'ok') {
  throw new Error('tryRun did not run the callback');
}

const order = [];
await Promise.all([
  locks.mutex('smoke:run').run(async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    order.push('first');
  }),
  locks.mutex('smoke:run').run(async () => {
    order.push('second');
  }),
]);
if (order.join(',') !== 'first,second') {
  throw new Error(`contended run was not serialised: ${order.join(',')}`);
}

console.log('smoke checks passed');
