/** The transaction capability is in the types: only backends that can join a transaction have `publishIn`. */
import { expectTypeOf, test } from 'vitest';

import type { PubSub, Unsubscribe } from './index.js';
import { memoryPubSub } from './memory.js';

test('memory has no publishIn', () => {
  const pubsub = memoryPubSub();
  expectTypeOf(pubsub).toEqualTypeOf<PubSub>();
  // @ts-expect-error -- memory cannot join a database transaction
  void pubsub.publishIn;
});

test("subscribe fits @arki/journal's WakeListener with no adapter", () => {
  const pubsub = memoryPubSub();
  // journal: `type WakeListener = (onMessage: (payload: string) => void) => Unlisten | Promise<Unlisten>`,
  // `type Unlisten = () => void | Promise<void>`.
  type Unlisten = () => void | Promise<void>;
  type WakeListener = (onMessage: (payload: string) => void) => Unlisten | Promise<Unlisten>;
  const listen = (onMessage: (payload: string) => void) => pubsub.subscribe('wake', onMessage);
  expectTypeOf(listen).toExtend<WakeListener>();
  expectTypeOf(listen).returns.resolves.toEqualTypeOf<Unsubscribe>();
});
