/**
 * entrypoints/procedures.ts: the feature's whole procedure tree in one file.
 * Each leaf is a factory over the feature's implementer. The import below is
 * `import type`, so the emitted module never imports `feature.ts` back — no
 * cycle, no TDZ (the orpc test transpiles this file to check).
 * Every procedure calls a usecase.
 */
import type { rpcImplementer } from './feature.js';
import { authed } from '../orpc.js';

export const digestProcedures = {
  preview: (impl: typeof rpcImplementer) =>
    impl.preview.use(authed).handler(({ context }) => {
      // `db` is entrypoint-only: a procedure may open a transaction with it; usecases never see it.
      void context.db;
      return context.usecases.preview(context.session.user.id);
    }),
};
