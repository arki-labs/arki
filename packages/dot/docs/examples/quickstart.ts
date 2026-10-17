/**
 * The quickstart app: an in-memory database and an orders service that needs it.
 *
 * `docs/quickstart.md` shows the regions below, and its run blocks call
 * `dot explain` and `dot doctor` on this file. `src/tests/quickstart-example.test.ts`
 * boots it, so the tutorial cannot drift from what the kernel does.
 */
import { defineApp, plugin } from '@arki/dot';

// #region database
type Order = { readonly id: number; readonly cents: number };

export const database = plugin({
  name: 'database',
  provides: {
    // A stand-in for a real client. It is a plain array, so nobody gets paged at 3 a.m.
    db: () => {
      const rows: Order[] = [];
      return {
        insert: (row: Order) => rows.push(row),
        count: () => rows.length,
      };
    },
  },
});
// #endregion database

// #region orders
export const orders = plugin({
  name: 'orders',
  needs: { db: database.provides.db }, // the handle, not a string: a typo cannot compile
  provides: {
    orders: ({ db }) => ({
      place: (cents: number): Order => {
        const order = { id: db.count() + 1, cents };
        db.insert(order);
        return order;
      },
    }),
  },
});
// #endregion orders

// #region app
export default defineApp('shop').use(database).use(orders);
// #endregion app
