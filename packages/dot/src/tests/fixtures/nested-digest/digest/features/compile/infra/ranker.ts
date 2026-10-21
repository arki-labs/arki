/**
 * Private to `digest.compile` (and its own children). A CHILD's infra unit
 * that also needs the parent's `repos` — by alias, unbound: the child
 * declares `repos` in its `.needs()` and the parent remaps it by identity.
 */
import type { Tx } from '../../../../db.js';
import type { Repos } from '../../../infra/store.js';
import { infra, service } from '../../../../../../../unit-contract.js';

export const ranker = infra({
  name: 'ranker',
  needs: { repos: service<Repos>() },
  provides: {
    ranker: ({ repos }) => ({
      rank: (items: readonly string[]): string[] => {
        const ranked = [...items];
        ranked.sort();
        return ranked;
      },
      stored: (tx: Tx) => repos.withTx(tx).digests.count(),
    }),
  },
});
