/** App infra: a database and a billing service other features can need. */
import { infra } from '../../../unit.js';

export type Db = { readonly query: (sql: string) => Promise<number> };

export const database = infra({ name: 'database', provides: { db: (): Db => ({ query: async sql => sql.length }) } });

export const billing = infra({
  name: 'billing',
  provides: { entitlements: () => ({ planOf: async (userId: string) => (userId === 'u1' ? 'pro' : 'free') }) },
});
