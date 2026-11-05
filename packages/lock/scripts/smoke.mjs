// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser target.
// It exercises one call per path; the unit tests cover the details.

import { RandomSourceUnavailable } from '@arki/contracts';

import { createLocks } from '../dist/index.js';
import { memoryStore } from '../dist/memory.js';

const locks = createLocks({ store: memoryStore(), namespace: 'smoke' });

// Lock tokens need Web Crypto `getRandomValues`. React Native has none; an app installs
// `react-native-get-random-values`, which defines `globalThis.crypto.getRandomValues`.
// Without it the lock must fail closed: refuse, and never run the callback.
if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  let ran = false;
  const refused = await locks.mutex('smoke:no-entropy').tryRun(async () => {
    ran = true;
  });
  if (ran || !RandomSourceUnavailable.is(refused)) {
    throw new Error(
      'without getRandomValues, tryRun must refuse with RandomSourceUnavailable and not run the callback',
    );
  }
  // Stands in for the app's polyfill so the rest runs. Smoke only: Math.random is not a secure source.
  globalThis.crypto = {
    getRandomValues(bytes) {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      return bytes;
    },
  };
}

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
