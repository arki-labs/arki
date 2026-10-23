/** oRPC requires exceptions at its boundary; transact must see them to roll back. */
import { orThrow } from '@arki/failure';

import type { rpcImplementer } from '../feature.js';
import { transact } from './transact.js';

export const accountsProcedures = (impl: typeof rpcImplementer) => ({
  transfer: impl.transfer
    .use(transact)
    .handler(async ({ context, input }) => orThrow(await context.usecases.transfer(context, input))),
  balance: impl.balance.handler(async ({ context, input }) => orThrow(await context.usecases.balance(input.id))),
});
