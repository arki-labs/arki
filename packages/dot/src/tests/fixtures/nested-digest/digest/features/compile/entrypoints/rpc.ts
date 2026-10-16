import { oc } from '@orpc/contract';
import { z } from 'zod';

export const compileRpcContract = oc.router({
  run: oc
    .input(z.object({ userId: z.string(), items: z.array(z.string()) }))
    .output(z.object({ id: z.string(), items: z.array(z.string()) })),
});
