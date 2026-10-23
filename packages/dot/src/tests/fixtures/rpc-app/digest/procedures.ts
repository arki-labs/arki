import { orThrow } from '@arki/failure';

/**
 * entrypoints/procedures.ts: the feature's whole procedure tree in one file.
 * The procedures are one function of the feature's implementer. The import below is
 * `import type`, so the emitted module never imports `feature.ts` back — no
 * cycle, no TDZ (the orpc test transpiles this file to check).
 * Every procedure calls a usecase.
 */
import type { rpcImplementer } from './feature.js';
import { authed } from '../orpc.js';

export const digestProcedures = (impl: typeof rpcImplementer) => ({
  preview: impl.preview.use(authed).handler(async ({ context }) => {
    // `db` is entrypoint-only: a procedure may open a transaction with it; usecases never see it.
    void context.db;
    return orThrow(await context.usecases.preview(context.session.user.id));
  }),
});
