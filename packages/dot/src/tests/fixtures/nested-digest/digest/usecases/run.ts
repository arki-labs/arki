import type { Tx } from '../../db.js';
import type { DigestDeps } from '../feature.js';

/** Compile, then deliver, inside the caller's transaction — passed on explicitly. A failed delivery leaves no digest behind. */
export const run =
  ({ compiler, delivery }: Pick<DigestDeps, 'compiler' | 'delivery'>) =>
  async (tx: Tx, userId: string, items: readonly string[]) => {
    const { id } = await compiler.compile(tx, userId, items);
    const { status } = await delivery.send(tx, id);
    return { id, status };
  };
