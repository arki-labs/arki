import type { Tx } from '../../../../db.js';
import type { DeliverDeps } from '../feature.js';

/** Mail one digest and mark it sent, inside the caller's transaction. A failed mail throws, so the caller rolls back. */
export const send =
  ({ repos, mailer }: Pick<DeliverDeps, 'repos' | 'mailer'>) =>
  async (tx: Tx, digestId: string) => {
    const digests = repos.withTx(tx).digests;
    const digest = await digests.get(digestId);
    if (digest === null) return { status: 'missing' } as const;
    if (!(await mailer.send(digest.userId))) throw new Error(`mail to ${digest.userId} failed`);
    await digests.markSent(digestId);
    return { status: 'sent' } as const;
  };
