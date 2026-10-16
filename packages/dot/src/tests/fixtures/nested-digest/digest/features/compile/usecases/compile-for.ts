import type { Tx } from '../../../../db.js';
import type { CompileDeps } from '../feature.js';

/** Build one digest inside the caller's transaction: the child `rank` picks the items, the parent's `repos` store them. */
export const compileFor =
  ({ repos, ranking }: Pick<CompileDeps, 'repos' | 'ranking'>) =>
  async (tx: Tx, userId: string, items: readonly string[]) => {
    const { ranked, stored } = await ranking.top(tx, items);
    const id = `d_${userId}_${stored + 1}`;
    await repos.withTx(tx).digests.create({ id, userId, status: 'compiled', items: ranked });
    return { id, items: ranked };
  };
