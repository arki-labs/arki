import { orThrow } from '@arki/failure';

/** The feature's procedures, one tree shaped like its contract. The entrypoint opens the transaction; the usecase takes `tx`. */
import type { rpcImplementer } from '../feature.js';

export const compileProcedures = {
  run: (o: typeof rpcImplementer) =>
    o.run.handler(({ context, input }) =>
      context.db.transaction(async tx => orThrow(await context.usecases.compileFor(tx, input.userId, input.items))),
    ),
};
