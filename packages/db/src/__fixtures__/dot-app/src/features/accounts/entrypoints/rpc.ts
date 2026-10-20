import { oc } from '@orpc/contract';
import { z } from 'zod';

import { TRANSACTION_FAILURES } from '@arki/db/errors';
import { errorMap } from '@arki/failure/orpc';

export const accountsRpcContract = {
  transfer: oc
    .errors(errorMap(...TRANSACTION_FAILURES))
    .input(z.object({ from: z.string(), to: z.string(), cents: z.int().positive() }))
    .output(z.object({ from: z.number(), to: z.number() })),
  balance: oc
    .errors(errorMap(...TRANSACTION_FAILURES))
    .input(z.object({ id: z.string() }))
    .output(z.number().nullable()),
};
