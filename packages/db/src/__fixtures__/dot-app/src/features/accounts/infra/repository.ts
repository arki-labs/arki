/** The feature's repositories. Each factory takes the pool or a transaction. */
import { eq, sql } from 'drizzle-orm';

import type { Database } from '../../../core/database.js';
import { repos } from '../../../../../../dot.js';
import { accounts } from '../model/tables.js';

function accountRepository(db: Database) {
  return {
    async balance(id: string): Promise<number | null> {
      const [row] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, id));
      return row?.balance ?? null;
    },
    async add(id: string, cents: number): Promise<void> {
      await db
        .update(accounts)
        .set({ balance: sql`${accounts.balance} + ${cents}` })
        .where(eq(accounts.id, id));
    },
  };
}

export const repository = repos({ accounts: accountRepository });
