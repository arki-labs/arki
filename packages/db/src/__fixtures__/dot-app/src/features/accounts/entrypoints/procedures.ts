/** Procedures call usecases. `transact` is always the last `.use()`. */
import type { rpcImplementer } from '../feature.js';
import { transact } from './transact.js';

export const accountsProcedures = {
  transfer: (impl: typeof rpcImplementer) =>
    impl.transfer.use(transact).handler(({ context, input }) => context.usecases.transfer(context, input)),
  balance: (impl: typeof rpcImplementer) =>
    impl.balance.handler(({ context, input }) => context.usecases.balance(input.id)),
};
