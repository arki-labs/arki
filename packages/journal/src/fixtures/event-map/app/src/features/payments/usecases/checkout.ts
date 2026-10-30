import { z } from 'zod';

import { j } from '../../../journal.js';
import { order, OrderPlaced } from '../../orders/model.js';
import { cancelOrder } from '../../orders/usecases/cancel-order.js';
import { payment, PaymentSettled } from '../model.js';
import { chargePayment, refundPayment } from './charge.js';

const input = z.object({ orderId: z.string(), total: z.int() });

/**
 * Started after the order commits. It charges (and refunds if a later node fails), waits for the payment
 * provider's settlement event, then fans out. `log` is a free-form step: the map cannot see inside it.
 */
export const checkout = j
  .workflow('checkout', {
    version: 1,
    input,
    startOn: {
      entity: order,
      event: OrderPlaced,
      timing: 'after-commit',
      id: e => `checkout:${e.entityId}`,
      input: e => ({ orderId: e.entityId, total: e.data.total }),
    },
  })
  .command('charge', chargePayment, ({ input: run }) => ({ id: `pay_${run.orderId}`, amount: run.total }), {
    undo: { command: refundPayment, input: ({ input: run }) => ({ id: `pay_${run.orderId}`, reason: 'checkout failed' }) },
  })
  .waitFor('confirm', {
    on: { settled: { entity: payment, events: [PaymentSettled], match: ({ input: run }) => `pay_${run.orderId}` } },
  })
  .parallel(
    'notify',
    {
      mail: branch => branch.step('send-mail', () => 'mailed').finish(),
      push: branch =>
        branch
          .command('release', cancelOrder, ({ input: run }) => ({ id: run.orderId, reason: 'released' }))
          .finish(),
    },
    { wait: 'all' },
  )
  .step('log', () => 'logged')
  .finish();

/** Started in the same transaction as the event: the run exists exactly when the order does. */
export const reserveStock = j
  .workflow('reserve-stock', {
    version: 1,
    input,
    startOn: {
      entity: order,
      event: OrderPlaced,
      timing: 'with-event',
      id: e => `reserve:${e.entityId}`,
      input: e => ({ orderId: e.entityId, total: e.data.total }),
    },
  })
  .step('hold', () => 'held')
  .finish();
