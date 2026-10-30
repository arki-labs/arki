/**
 * `locks(...)` — the lock manager as a Dot unit.
 *
 * Features that need `locks` get the handle at boot, and the store's `dispose`
 * runs when the app stops. The handle is typed by the store's guarantees
 * (`LocksFor<G>`), so `lead`, `semaphore` and `readWrite` exist only when the
 * store can do them, and a test can provide any store with the same guarantees
 * (`testStore` from `@arki/lock/testing`).
 */
import type { CtxOf, EmptyShape, NeedsShape, NoReservedKeys } from '@arki/dot/unit';
import { isFailure, UnexpectedFailure } from '@arki/failure';
import { infra } from '@arki/dot/unit';

import type { CreateLocksOptions, Guarantees, LocksFor, Store } from '../types.js';
import { LockError } from '../errors.js';
import { createLocks } from '../locks.js';

/** What `locks(...)` takes. `store` builds the store from the services named in `needs`. */
export type LocksPluginOptions<TShape extends NeedsShape, S extends Store> = {
  /** Prefix for every key, so two apps on one backend never collide. */
  readonly namespace: string;
  /** Services the store factory reads, e.g. `{ db: database.provides.db }`. */
  readonly needs?: TShape;
  readonly store: (deps: CtxOf<TShape>) => S;
  /** Allow a process-scope store in production. Only right for a single-replica app. */
  readonly allowProcessScope?: boolean;
  readonly storeTimeout?: CreateLocksOptions<S>['storeTimeout'];
  readonly onReleaseError?: CreateLocksOptions<S>['onReleaseError'];
};

/** True when `NODE_ENV` is `production`. Safe on runtimes with no `process`. */
function inProduction(): boolean {
  return typeof process !== 'undefined' && process.env['NODE_ENV'] === 'production';
}

/** A process-scope store in production means every replica runs the job. Refuse it unless asked. */
function assertStoreFitsEnvironment(store: Store, allowProcessScope: boolean | undefined): void {
  if (allowProcessScope === true || !inProduction() || store.guarantees.scope !== 'process') return;
  throw new LockError({
    code: 'config',
    message: `lock store "${store.name}" has process scope, but NODE_ENV is production`,
    remediation:
      'a process-scope lock store excludes callers in this process only; every replica would run the job — use pgSession/pgLease/redisStore, or set allowProcessScope: true for a single-replica app',
  });
}

/**
 * Publish `locks`. The store is built, checked and wrapped at boot; a bad store fails the boot.
 *
 * @example
 * ```ts
 * defineApp('billing').infra(locks({ namespace: 'billing', needs: { db }, store: ({ db }) => pgLease(db) }));
 * ```
 */
export function locks<G extends Guarantees, TShape extends NeedsShape & NoReservedKeys = EmptyShape>(
  options: LocksPluginOptions<TShape, Store<G>>,
) {
  const { namespace, store, allowProcessScope, storeTimeout, onReleaseError } = options;
  return infra({
    name: 'locks',
    ...(options.needs === undefined ? {} : { needs: options.needs }),
    provides: {
      locks: (deps: CtxOf<TShape>): LocksFor<G> => {
        const built = store(deps);
        assertStoreFitsEnvironment(built, allowProcessScope);
        return createLocks({
          store: built,
          namespace,
          ...(storeTimeout === undefined ? {} : { storeTimeout }),
          ...(onReleaseError === undefined ? {} : { onReleaseError }),
        });
      },
    },
    async dispose({ locks: handle }) {
      // Dot disposal is a foreign void protocol; its supervisor receives canonical evidence.
      const outcome = await handle.store.dispose?.();
      if (isFailure(outcome)) throw new UnexpectedFailure(outcome);
    },
  });
}

/** What a lock service is backed by, for `dot explain` text. */
export type LocksDescription = {
  readonly store: string;
  readonly kind: Store['guarantees']['kind'];
  readonly scope: Store['guarantees']['scope'];
  readonly fence: Store['guarantees']['fence'];
  readonly releasedOnCrash: Store['guarantees']['releasedOnCrash'];
};

/** Name the store behind a lock service and what it promises. */
export function describeLocks(service: { readonly store: Store }): LocksDescription {
  const { name, guarantees } = service.store;
  return {
    store: name,
    kind: guarantees.kind,
    scope: guarantees.scope,
    fence: guarantees.fence,
    releasedOnCrash: guarantees.releasedOnCrash,
  };
}
