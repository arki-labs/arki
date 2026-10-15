/** App infra: a database and a billing service other features can need. */
import { plugin } from '../../../plugin.js';

export type Db = { readonly query: (sql: string) => Promise<number> };

export const database = plugin({ name: 'database', provides: { db: (): Db => ({ query: async sql => sql.length }) } });

export const billing = plugin({
  name: 'billing',
  provides: { entitlements: () => ({ planOf: async (userId: string) => (userId === 'u1' ? 'pro' : 'free') }) },
});
