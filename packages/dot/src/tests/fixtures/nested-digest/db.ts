/**
 * A fake database with real transaction semantics, for the nesting tests.
 * `Tx` is branded: only `transaction(fn)` hands one out, so a plain `Db`
 * never passes as a `Tx`. A completed transaction is closed: any later use
 * throws. Rows are copied in and out, so nothing outside a transaction
 * holds a committed row.
 */
import { plugin } from '../../../plugin-contract.js';

export type Digest = { id: string; userId: string; status: 'compiled' | 'sent'; items: string[] };
declare const txBrand: unique symbol;
/** A transaction's staged tables. Branded: structurally a `Db` is not one. */
export type Tx = { readonly [txBrand]: true; readonly digests: Map<string, Digest> };
export type Db = { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };

const closed = new WeakSet<Tx>();
/** Every repository call checks this: a transaction that has committed or rolled back is unusable. */
export const assertOpen = (tx: Tx): void => {
  if (closed.has(tx)) throw new Error('transaction closed');
};
const copy = (rows: Map<string, Digest>): Map<string, Digest> =>
  new Map([...rows].map(([k, v]) => [k, { ...v, items: [...v.items] }]));

export const createDb = (): Db => {
  const digests = new Map<string, Digest>();
  return {
    transaction: async fn => {
      // Erasure seam (test fake): the staged copy is the one thing allowed to be a `Tx`.
      const staged = { digests: copy(digests) } as Tx;
      try {
        const out = await fn(staged);
        digests.clear();
        for (const [k, v] of copy(staged.digests)) digests.set(k, v);
        return out;
      } finally {
        closed.add(staged);
      }
    },
  };
};

export const database = plugin({ name: 'database', provides: { db: createDb } });

/** A stand-in for `@arki/journal`'s `journalProjections(...)`: a need-free infra unit the adapter finds by `kind`. */
export const projectionsUnit = (projection: string) =>
  Object.assign(plugin({ name: 'projections', provides: {} }), {
    kind: 'journal-projections' as const,
    handlers: { projections: [{ name: projection }], effects: [] as const, taps: [] as const },
  });
export type ProjectionsUnit = ReturnType<typeof projectionsUnit>;
