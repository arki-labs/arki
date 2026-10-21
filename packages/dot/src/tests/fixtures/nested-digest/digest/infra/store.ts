/**
 * The parent's store: one `repos` set for the whole `digest` scope. Only
 * `withTx(tx)` hands out repositories, so every query runs inside a
 * transaction some entrypoint opened. The store declares `db` UNBOUND
 * (`service<Db>()`): it names no global handle; the feature passes its own
 * `db` at `.infra()`.
 */
import type { Db, Digest, Tx } from '../../db.js';
import { infra, service } from '../../../../../unit-contract.js';
import { assertOpen } from '../../db.js';

/** Repositories bound to one transaction. Exported so a test can build a second, unrelated `Repos` provider. */
export const bindRepos = (tx: Tx) => ({
  digests: {
    create: (d: Digest) => {
      assertOpen(tx);
      tx.digests.set(d.id, { ...d, items: [...d.items] });
      return Promise.resolve(d.id);
    },
    get: (id: string) => {
      assertOpen(tx);
      const row = tx.digests.get(id);
      return Promise.resolve(row === undefined ? null : { ...row, items: [...row.items] });
    },
    markSent: (id: string) => {
      assertOpen(tx);
      const row = tx.digests.get(id);
      if (row === undefined) return Promise.resolve(false);
      row.status = 'sent';
      return Promise.resolve(true);
    },
    count: () => {
      assertOpen(tx);
      return Promise.resolve(tx.digests.size);
    },
  },
});
export type RepoSet = ReturnType<typeof bindRepos>;
export type Repos = { withTx(tx: Tx): RepoSet };

export const store = infra({
  name: 'store',
  needs: { db: service<Db>() },
  provides: { repos: (): Repos => ({ withTx: tx => bindRepos(tx) }) },
});
