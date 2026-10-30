import { isFailure } from '@arki/failure';
/**
 * Chaos cases. The store's own test supplies the hooks that break things
 * (an adapter implements the ones it can); a hook that is missing, or does not
 * apply to the store, makes its case skip with the reason.
 */
import type { Grant, Store } from '../types.js';
import type { ContractCase, ContractOptions, MakeStore } from './contract.js';
import { check, defineCase, grab, leaseTtl, requestFor, skip, uniqueKey } from './contract.js';

export type ChaosHooks = {
  /** Make the holder vanish without releasing, as a crash would. */
  readonly killHolder?: (store: Store, grant: Grant) => Promise<void>;
  /** Make the next `count` renewals fail. */
  readonly failRenewals?: (store: Store, count: number) => Promise<void>;
  /** Cut the connection a held lock is pinned to. */
  readonly dropConnection?: (store: Store) => Promise<void>;
  /** Move the client's clock by `ms`; the store's clock must stay the judge. */
  readonly skewClock?: (store: Store, ms: number) => Promise<void>;
};

/** Let the store's bound pass: a lease expires, an immediate store needs nothing. */
async function waitOutBound(store: Store, options: ContractOptions): Promise<void> {
  if (store.guarantees.releasedOnCrash === 'immediate') return;
  const ttl = leaseTtl(store, options);
  if (ttl === undefined || options.advanceTime === undefined)
    skip('needs `ttl` and `advanceTime` to wait out the lease');
  await options.advanceTime(ttl + 1);
}

export function chaos(makeStore: MakeStore, hooks: ChaosHooks, options: ContractOptions = {}): ContractCase[] {
  return [
    defineCase('chaos: killing the holder frees the key within the bound', makeStore, options, async ({ store }) => {
      const { killHolder } = hooks;
      if (killHolder === undefined) skip('hook killHolder not supplied');
      const key = uniqueKey('chaos-kill');
      const grant = await grab(store, key, options);
      await killHolder(store, grant);
      await waitOutBound(store, options);
      await grab(store, key, options);
    }),

    defineCase(
      'chaos: failing renewals loses the lock and aborts the holder',
      makeStore,
      options,
      async ({ store, locks }) => {
        const { failRenewals } = hooks;
        if (failRenewals === undefined) skip('hook failRenewals not supplied');
        if (store.guarantees.kind !== 'lease') skip('hold store: nothing is renewed');
        const ttl = leaseTtl(store, options);
        if (ttl === undefined || options.advanceTime === undefined || options.scheduler === undefined) {
          skip('needs `ttl`, `advanceTime` and `scheduler` to drive renewals');
        }
        const guard = await locks.mutex(uniqueKey('chaos-renew').name).acquire({ wait: '1s' });
        check(!isFailure(guard), 'the lock should be free');
        await failRenewals(store, Number.MAX_SAFE_INTEGER);
        await options.advanceTime(ttl * 2);
        check(!guard.held && guard.signal.aborted, 'holder should know the lock is lost');
      },
    ),

    defineCase('chaos: dropping the pinned connection frees the key', makeStore, options, async ({ store }) => {
      const { dropConnection } = hooks;
      if (dropConnection === undefined) skip('hook dropConnection not supplied');
      const key = uniqueKey('chaos-drop');
      await grab(store, key, options);
      await dropConnection(store);
      await waitOutBound(store, options);
      await grab(store, key, options);
    }),

    defineCase('chaos: a skewed client clock does not free a held key', makeStore, options, async ({ store }) => {
      const { skewClock } = hooks;
      if (skewClock === undefined) skip('hook skewClock not supplied');
      const key = uniqueKey('chaos-skew');
      await grab(store, key, options);
      await skewClock(store, Math.floor((leaseTtl(store, options) ?? 4000) / 4));
      check((await store.acquire(key, requestFor(store, options))) === undefined, 'key should still be held');
    }),
  ];
}
