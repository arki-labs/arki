/**
 * A property test over three fake replicas sharing one store and one manual
 * clock. Invariant: at any instant at most one live guard holds a key.
 * A replica you never step is a paused process: its guards stay as they are.
 */
import * as fc from 'fast-check';

import { createLocks } from '../locks.js';
import type { Guard, Store } from '../types.js';
import { check } from './contract.js';
import type { ContractCase, MakeStore } from './contract.js';
import { manualScheduler } from './manual-scheduler.js';
import type { ManualScheduler } from './manual-scheduler.js';

export type ReplicaOptions = {
  /** The clock the store was built with. Default: a fresh one (right for stores with no clock of their own). */
  readonly scheduler?: ManualScheduler;
  /** fast-check runs. Default 50. */
  readonly numRuns?: number;
  /** Fixed seed, to replay a failure. */
  readonly seed?: number;
};

const REPLICAS = 3;
const KEYS = ['a', 'b'] as const;

type Step =
  | { readonly kind: 'acquire'; readonly replica: number; readonly key: number }
  | { readonly kind: 'release'; readonly pick: number }
  | { readonly kind: 'advance'; readonly ms: number };

const stepArbitrary: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('acquire' as const), replica: fc.nat(REPLICAS - 1), key: fc.nat(KEYS.length - 1) }),
  fc.record({ kind: fc.constant('release' as const), pick: fc.nat(1000) }),
  fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 60_000 }) }),
);

export function replicaCases(makeStore: MakeStore, options: ReplicaOptions = {}): ContractCase[] {
  return [
    {
      name: 'property: three replicas never hold one key at the same time',
      async run() {
        await fc.assert(
          fc.asyncProperty(fc.array(stepArbitrary, { maxLength: 40 }), async (steps) => {
            const clock = options.scheduler ?? manualScheduler();
            const store: Store = await makeStore();
            try {
              await runSteps(store, clock, steps);
            } finally {
              await store.dispose?.();
            }
          }),
          { numRuns: options.numRuns ?? 50, ...(options.seed === undefined ? {} : { seed: options.seed }) },
        );
      },
    },
  ];
}

async function runSteps(store: Store, clock: ManualScheduler, steps: readonly Step[]): Promise<void> {
  const namespace = `replicas-${Math.random().toString(36).slice(2)}`;
  const replicas = Array.from({ length: REPLICAS }, () => createLocks({ store, namespace, scheduler: clock }));
  const live: { readonly key: number; readonly guard: Guard<Store> }[] = [];

  for (const step of steps) {
    if (step.kind === 'acquire') {
      const guard = await replicas[step.replica]?.mutex(KEYS[step.key] ?? 'a').tryAcquire();
      if (guard !== undefined) live.push({ key: step.key, guard });
    } else if (step.kind === 'release') {
      const [entry] = live.splice(step.pick % Math.max(live.length, 1), 1);
      await entry?.guard.release();
    } else {
      await clock.advance(step.ms);
    }
    for (const [key, name] of KEYS.entries()) {
      const holders = live.filter((entry) => entry.key === key && entry.guard.held).length;
      check(holders <= 1, `${holders} replicas hold key ${name} at once`);
    }
  }
  for (const entry of live) await entry.guard.release();
}
