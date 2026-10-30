import { z } from 'zod';

import { j } from '../../../journal.js';
import { order, OrderCancelled } from '../model.js';

export const cancelOrder = j.command(
  'cancel-order',
  z.object({ id: z.string().min(1), reason: z.string().min(1) }),
  { writes: [OrderCancelled] },
  (input, { write }) => write(order, input.id, () => [OrderCancelled({ reason: input.reason })]),
);
