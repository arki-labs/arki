// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser and Hermes.
// It exercises one call per path; the conformance suite covers the details.

import { PubSubError } from '../dist/index.js';
import { memoryPubSub } from '../dist/memory.js';

const pubsub = memoryPubSub();
const received = [];
const unsubscribe = await pubsub.subscribe('smoke', payload => received.push(payload));
await pubsub.publish('smoke', 'one');
await pubsub.publish('smoke', 'two');
await new Promise(resolve => setTimeout(resolve, 5));
if (received.join(',') !== 'one,two') {
  throw new Error(`memory pubsub delivered ${received.join(',')}`);
}

let refused = false;
try {
  await pubsub.publish('Not A Channel', 'x');
} catch (error) {
  refused = error instanceof PubSubError && error.code === 'channel';
}
if (!refused) throw new Error('a bad channel was not refused');

await unsubscribe();
await pubsub.close();
console.log('smoke checks passed');
