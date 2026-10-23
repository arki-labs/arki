# @arki/pubsub

Publish and subscribe on named channels, with one contract over memory, a polled message table (Postgres or SQLite), Postgres LISTEN/NOTIFY and Redis. Delivery is best effort, like NOTIFY.

## Usage

```ts run
import { memoryPubSub } from '@arki/pubsub/memory';

const pubsub = memoryPubSub();
const received: string[] = [];
const unsubscribe = await pubsub.subscribe('orders_changed', payload => received.push(payload));

await pubsub.publish('orders_changed', 'ord_1');
await new Promise(resolve => setTimeout(resolve, 0));
if (received[0] !== 'ord_1') throw new Error('not delivered');

await unsubscribe();
await pubsub.close();
```
