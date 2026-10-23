import { orThrow } from '@arki/failure';

/** The feature's procedures, one tree shaped like its contract. Entrypoints open the transaction; usecases take `tx`. */
import type { rpcImplementer } from '../feature.js';
import { compile } from '../features/compile/feature.js';
import { deliver } from '../features/deliver/feature.js';

export const digestProcedures = (impl: typeof rpcImplementer) => ({
  run: impl.run.handler(({ context, input }) =>
    context.db.transaction(async tx => orThrow(await context.usecases.run(tx, input.userId, input.items))),
  ),
  // An inline group with no child owner: its procedures stay declared as this feature's actions.
  admin: { ping: impl.admin.ping.handler(() => 'pong') },
  // Mounted children: their routers, under the keys the contract gives them.
  compile: compile.router,
  deliver: deliver.router,
});
