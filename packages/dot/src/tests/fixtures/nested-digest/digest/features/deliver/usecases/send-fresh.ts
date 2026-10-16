import type { Tx } from '../../../../db.js';
import type { DeliverDeps } from '../feature.js';

/** Compile through the sibling's provided service, then send — all inside the caller's transaction. */
export const sendFresh =
  ({ compiler, mailer, repos }: Pick<DeliverDeps, 'compiler' | 'mailer' | 'repos'>) =>
  async (tx: Tx, userId: string, items: readonly string[]) => {
    const { id } = await compiler.compile(tx, userId, items);
    if (!(await mailer.send(userId))) throw new Error(`mail to ${userId} failed`);
    await repos.withTx(tx).digests.markSent(id);
    return { status: 'sent', id } as const;
  };
