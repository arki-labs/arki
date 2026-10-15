/** infra/: the feature's own store. It needs `db`; the feature's handlers never see `db`. */
import { plugin } from '../../../../plugin.js';
import { database } from '../infra.js';

export const store = plugin({
  name: 'store',
  needs: { db: database.provides.db },
  provides: {
    store: ({ db }) => ({
      pendingFor: async (userId: string) => ({
        id: `d_${await db.query(userId)}`,
        items: ['a', 'b', 'c', 'd', 'e', 'f'],
      }),
    }),
  },
});
