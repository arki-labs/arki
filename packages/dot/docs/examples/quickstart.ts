/**
 * The quickstart app: an in-memory database, a session store on top of it, and an
 * orders feature that needs the database.
 *
 * `docs/quickstart.md` shows the regions below, and its run blocks call
 * `dot explain` and `dot doctor` on this file. `src/tests/quickstart-example.test.ts`
 * boots it, so the tutorial cannot drift from what the kernel does.
 */
import { defineApp, infra } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';

// #region database
type Order = { readonly id: number; readonly cents: number };

export const database = infra({
  name: 'database',
  provides: {
    // A stand-in for a real client: tables are plain arrays, so nobody gets paged at 3 a.m.
    db: () => {
      const tables = new Map<string, unknown[]>();
      const table = (name: string): unknown[] => tables.get(name) ?? tables.set(name, []).get(name) ?? [];
      return {
        insert: (name: string, row: unknown) => table(name).push(row),
        count: (name: string) => table(name).length,
      };
    },
  },
});
// #endregion database

// #region sessions
export const sessions = infra({
  name: 'sessions',
  needs: { db: database.provides.db }, // the handle, not a string: a typo cannot compile
  provides: {
    sessions: ({ db }) => ({
      open: (userId: string) => {
        db.insert('sessions', { userId });
        return { userId };
      },
    }),
  },
});
// #endregion sessions

// #region orders
export const orders = defineFeature('orders')
  .needs({ db: database.provides.db })
  .usecases({
    place:
      ({ db }) =>
      (cents: number): Order => {
        const order = { id: db.count('orders') + 1, cents };
        db.insert('orders', order);
        return order;
      },
  })
  .provides({ orders: ({ usecases }) => ({ place: usecases.place }) })
  .entrypoints(); // nothing calls orders from outside yet
// #endregion orders

// #region app
export default defineApp('shop').infra(database, sessions).features([orders]);
// #endregion app
