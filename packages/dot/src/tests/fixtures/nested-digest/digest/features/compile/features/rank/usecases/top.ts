import type { Tx } from '../../../../../../db.js';
import type { RankDeps } from '../feature.js';

/** Rank, and report how many digests the caller's transaction already sees — grandparent `repos` + parent `ranker`. */
export const top =
  ({ ranker, repos }: Pick<RankDeps, 'ranker' | 'repos'>) =>
  async (tx: Tx, items: readonly string[], limit = 3) => {
    const ranked = ranker.rank(items).slice(0, limit);
    return { ranked, stored: await repos.withTx(tx).digests.count() };
  };
