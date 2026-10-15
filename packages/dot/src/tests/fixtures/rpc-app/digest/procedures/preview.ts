/**
 * procedures/preview.ts: one procedure, one file, a factory over the feature's
 * implementer. The suffix keeps it apart from the `preview` usecase. The
 * import below is `import type`, so the emitted module never imports
 * `feature.ts` back — no cycle, no TDZ (the orpc test transpiles this file to check).
 */
import type { os } from '../feature.js';
import { authed } from '../../orpc.js';

export const previewProcedure = (o: typeof os) =>
  o.preview.use(authed).handler(({ context }) => {
    // @ts-expect-error -- `db` is the store's need, not the feature's: it never reaches a handler
    void context.db;
    return context.usecases.preview(context.session.user.id);
  });
