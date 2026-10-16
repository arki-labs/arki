/** The parent's contract mounts its children's contracts. Mount keys are written once, here. */
import { oc } from '@orpc/contract';
import { z } from 'zod';

import { compileRpcContract } from '../features/compile/entrypoints/rpc.js';
import { deliverRpcContract } from '../features/deliver/entrypoints/rpc.js';

export const digestRpcContract = oc.router({
  run: oc
    .input(z.object({ userId: z.string(), items: z.array(z.string()) }))
    .output(z.object({ id: z.string(), status: z.enum(['sent', 'missing']) })),
  admin: { ping: oc.output(z.string()) },
  compile: compileRpcContract,
  deliver: deliverRpcContract,
});
