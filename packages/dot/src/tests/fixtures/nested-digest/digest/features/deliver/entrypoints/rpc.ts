import { oc } from '@orpc/contract';
import { z } from 'zod';

const sendResult = z.object({ status: z.enum(['sent', 'missing']) });

export const deliverRpcContract = oc.router({
  send: oc.input(z.object({ digestId: z.string() })).output(sendResult),
  sendFresh: oc
    .input(z.object({ userId: z.string(), items: z.array(z.string()) }))
    .output(sendResult.extend({ id: z.string() })),
});
