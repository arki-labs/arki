/** The feature's procedures, one tree shaped like its contract. Entrypoints open the transaction; usecases take `tx`. */
import type { rpcImplementer } from '../feature.js';
import { compile } from '../features/compile/feature.js';
import { deliver } from '../features/deliver/feature.js';

export const digestProcedures = {
  run: (o: typeof rpcImplementer) =>
    o.run.handler(({ context, input }) =>
      context.db.transaction(tx => context.usecases.run(tx, input.userId, input.items)),
    ),
  // An inline group with no child owner: its procedures stay declared as this feature's actions.
  admin: (o: typeof rpcImplementer) => ({ ping: o.admin.ping.handler(() => 'pong') }),
  // Mounted children: their routers, under the keys the contract gives them.
  compile: () => compile.router,
  deliver: () => deliver.router,
};
