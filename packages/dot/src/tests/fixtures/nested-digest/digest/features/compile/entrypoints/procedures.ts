/** The feature's procedures, one tree shaped like its contract. The entrypoint opens the transaction; the usecase takes `tx`. */
import type { rpcImplementer } from '../feature.js';

export const compileProcedures = {
  run: (o: typeof rpcImplementer) =>
    o.run.handler(({ context, input }) =>
      context.db.transaction(tx => context.usecases.compileFor(tx, input.userId, input.items)),
    ),
};
