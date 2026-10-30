import { z } from 'zod';

import { needsOf } from '../../../../../../../dot.js';
import { j } from '../../../journal.js';
import type { Deps } from '../feature.js';
import { order, OrderPlaced } from '../model.js';

/** The decision: place an order. */
export const placeOrder = j.command(
  'place-order',
  z.object({ id: z.string().min(1), total: z.int().positive() }),
  { writes: [OrderPlaced] },
  (input, { write }) => write(order, input.id, () => [OrderPlaced({ total: input.total })]),
);

/** The reaction that follows it: an effect only reaches out, here to the mailer. */
export const sendReceipt = j.effect(
  'send-receipt',
  order,
  needsOf((_: Deps) => ['mailer']),
  { OrderPlaced: (e, { mailer }) => mailer.send(e.entityId) },
);
