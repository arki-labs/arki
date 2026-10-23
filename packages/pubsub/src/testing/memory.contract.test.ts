import { memoryPubSub } from '../memory.js';
import { describePubSubContract } from './index.js';

// Each memoryPubSub() is its own bus, so the cross-instance cases do not apply.
describePubSubContract('memory', () => Promise.resolve({ pubsub: memoryPubSub() }), { settleMs: 20, shared: false });
