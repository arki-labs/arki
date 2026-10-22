/**
 * Declared once per feature: which database, which repositories, how many retries.
 * An entrypoint sees only the entrypoint-only `db`, never the feature's infra, so the
 * transaction's repositories are built here from the same factory the infra uses.
 */
import type { Db, Transaction } from '../../../core/database.js';
import { transactionalProcedure } from '../../../../../../orpc.js';
import { accountRepository } from '../infra/repository.js';

export const transact = transactionalProcedure((ctx: { readonly db: Db }) => ctx.db, {
  isolation: 'serializable',
  retries: 3,
  repos: () => ({ withTx: (tx: Transaction) => ({ accounts: accountRepository(tx) }) }),
});
