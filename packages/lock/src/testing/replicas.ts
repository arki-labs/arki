import { orThrow } from '@arki/failure';
import { isFailure } from '@arki/failure';
/**
 * A property test over three fake replicas sharing one store and one manual
 * clock. Invariant: at any instant at most one live guard holds a mutex key, and
 * (on stores with permits) the live semaphore weights never add up past the limit.
 * A replica you never step is a paused process: its guards stay as they are.
 */
import * as fc from 'fast-check';

import type { Scheduler } from '../scheduler.js';
import type { Guard, Store } from '../types.js';
import type { ContractCase, MakeStore } from './contract.js';
import type { ManualScheduler } from './manual-scheduler.js';
import { createLocks } from '../locks.js';
import { check, ContractSkip, hasSemaphore, resolveMade } from './contract.js';
import { manualScheduler } from './manual-scheduler.js';

export type ReplicaOptions = {
  /** The clock the store was built with. Default: a fresh one (right for stores with no clock of their own). */
  readonly scheduler?: ManualScheduler;
  /** fast-check runs. Default 50. */
  readonly numRuns?: number;
  /** Fixed seed, to replay a failure. */
  readonly seed?: number;
};

function isManual(scheduler: Scheduler | undefined): scheduler is ManualScheduler {
  return scheduler !== undefined && !isFailure(scheduler) && 'advance' in scheduler;
}

const REPLICAS = 3;
const KEYS = ['a', 'b'] as const;
const POOL_LIMIT = 3;
const POOL_WEIGHT_MAX = 3;

type Step =
  | { readonly kind: 'acquire'; readonly replica: number; readonly key: number; readonly weight: number }
  | { readonly kind: 'release'; readonly pick: number }
  | { readonly kind: 'advance'; readonly ms: number };

const stepArbitrary: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('acquire' as const),
    replica: fc.nat(REPLICAS - 1),
    key: fc.nat(KEYS.length - 1),
    weight: fc.integer({ min: 1, max: POOL_WEIGHT_MAX }),
  }),
  fc.record({ kind: fc.constant('release' as const), pick: fc.nat(1000) }),
  fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 60_000 }) }),
);

export function replicaCases(makeStore: MakeStore, options: ReplicaOptions = {}): ContractCase[] {
  const property = (
    name: string,
    run: (store: Store, clock: ManualScheduler, steps: readonly Step[]) => Promise<void>,
    needs?: (store: Store) => string | undefined,
  ): ContractCase => ({
    name,
    async run() {
      if (needs !== undefined && !isFailure(needs)) {
        const { store: probe } = resolveMade(await makeStore(), {});
        try {
          const reason = needs(probe);
          if (reason !== undefined && !isFailure(reason)) throw new ContractSkip(reason);
        } finally {
          orThrow(await probe.dispose?.());
        }
      }
      await fc.assert(
        fc.asyncProperty(fc.array(stepArbitrary, { maxLength: 40 }), async steps => {
          const made = resolveMade(await makeStore(), {});
          const { store } = made;
          // A per-case manual scheduler from the store wins over the fixed one.
          const clock = isManual(made.options.scheduler)
            ? made.options.scheduler
            : (options.scheduler ?? manualScheduler());
          try {
            await run(store, clock, steps);
          } finally {
            orThrow(await store.dispose?.());
          }
        }),
        { numRuns: options.numRuns ?? 50, ...(options.seed === undefined ? {} : { seed: options.seed }) },
      );
    },
  });

  return [
    property('property: three replicas never hold one key at the same time', runSteps),
    property(
      `property: three replicas never use more than ${POOL_LIMIT} permits of one semaphore`,
      runPermitSteps,
      store => (store.guarantees.permits ? undefined : 'this store has no permits'),
    ),
  ];
}

async function runSteps(store: Store, clock: ManualScheduler, steps: readonly Step[]): Promise<void> {
  const namespace = `replicas-${Math.random().toString(36).slice(2)}`;
  const replicas = Array.from({ length: REPLICAS }, () => createLocks({ store, namespace, scheduler: clock }));
  const live: { readonly key: number; readonly guard: Guard<Store> }[] = [];

  for (const step of steps) {
    if (step.kind === 'acquire') {
      const guard = await replicas[step.replica]?.mutex(KEYS[step.key] ?? 'a').tryAcquire();
      if (guard !== undefined && !isFailure(guard) && !isFailure(guard)) live.push({ key: step.key, guard });
    } else if (step.kind === 'release') {
      const [entry] = live.splice(step.pick % Math.max(live.length, 1), 1);
      orThrow(await entry?.guard.release());
    } else {
      await clock.advance(step.ms);
    }
    for (const [key, name] of KEYS.entries()) {
      const holders = live.filter(entry => entry.key === key && entry.guard.held).length;
      check(holders <= 1, `${holders} replicas hold key ${name} at once`);
    }
  }
  for (const entry of live) orThrow(await entry.guard.release());
}

async function runPermitSteps(store: Store, clock: ManualScheduler, steps: readonly Step[]): Promise<void> {
  const namespace = `replicas-${Math.random().toString(36).slice(2)}`;
  const replicas = Array.from({ length: REPLICAS }, () => createLocks({ store, namespace, scheduler: clock }));
  const live: { readonly key: number; readonly weight: number; readonly guard: Guard<Store> }[] = [];

  for (const step of steps) {
    if (step.kind === 'acquire') {
      const replica = replicas[step.replica];
      const pool =
        replica !== undefined && !isFailure(replica) && hasSemaphore(replica)
          ? replica.semaphore(KEYS[step.key] ?? 'a', { limit: POOL_LIMIT })
          : undefined;
      const guard = await pool?.tryAcquire({ weight: step.weight });
      if (guard !== undefined && !isFailure(guard) && !isFailure(guard)) live.push({ key: step.key, weight: step.weight, guard });
    } else if (step.kind === 'release') {
      const [entry] = live.splice(step.pick % Math.max(live.length, 1), 1);
      orThrow(await entry?.guard.release());
    } else {
      await clock.advance(step.ms);
    }
    for (const [key, name] of KEYS.entries()) {
      const inUse = live
        .filter(entry => entry.key === key && entry.guard.held)
        .reduce((sum, entry) => sum + entry.weight, 0);
      check(inUse <= POOL_LIMIT, `${inUse} permits of semaphore ${name} are in use, the limit is ${POOL_LIMIT}`);
    }
  }
  for (const entry of live) orThrow(await entry.guard.release());
}
