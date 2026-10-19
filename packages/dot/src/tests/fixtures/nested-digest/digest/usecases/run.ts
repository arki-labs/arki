import { isFailure } from '@arki/failure';

import type { Tx } from '../../db.js';
import type { DigestDeps } from '../feature.js';

/** Compile, then deliver, inside the caller's transaction — passed on explicitly. A failed delivery leaves no digest behind. */
export const run =
  ({ compiler, delivery }: Pick<DigestDeps, 'compiler' | 'delivery'>) =>
  async (tx: Tx, userId: string, items: readonly string[]) => {
    const compiled = await compiler.compile(tx, userId, items);
    if (isFailure(compiled)) return compiled;
    const { id } = compiled;
    const delivered = await delivery.send(tx, id);
    if (isFailure(delivered)) return delivered;
    const { status } = delivered;
    return { id, status };
  };
