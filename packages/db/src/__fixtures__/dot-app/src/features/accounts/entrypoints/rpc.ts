import { oc } from '@orpc/contract';
import { z } from 'zod';

export const accountsRpcContract = {
  transfer: oc
    .input(z.object({ from: z.string(), to: z.string(), cents: z.int().positive() }))
    .output(z.object({ from: z.number(), to: z.number() })),
  balance: oc.input(z.object({ id: z.string() })).output(z.number().nullable()),
};
