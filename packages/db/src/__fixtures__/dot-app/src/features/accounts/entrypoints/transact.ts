/** Declared once per feature: which database, which repositories, how many retries. */
import type { Deps } from '../feature.js';
import { transactionalProcedure } from '../../../../../../orpc.js';

export const transact = transactionalProcedure((ctx: Pick<Deps, 'db' | 'repositories'>) => ctx.db, {
  isolation: 'serializable',
  retries: 3,
  repos: ctx => ctx.repositories,
});
