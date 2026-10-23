import { orThrow } from '@arki/failure';

/** The feature's procedures, one tree shaped like its contract. Entrypoints open the transaction; usecases take `tx`. */
import type { rpcImplementer } from '../feature.js';

export const deliverProcedures = (impl: typeof rpcImplementer) => ({
  send: impl.send.handler(({ context, input }) =>
    context.db.transaction(async tx => orThrow(await context.usecases.send(tx, input.digestId))),
  ),
  sendFresh: impl.sendFresh.handler(({ context, input }) =>
    context.db.transaction(async tx => orThrow(await context.usecases.sendFresh(tx, input.userId, input.items))),
  ),
});
