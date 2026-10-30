/** reaction.test-d.ts of the two-file fixture: it imports the feature's `Deps` as a type only. */
import { needsOf } from '../../dot.js';
import { j, order } from '../../test-support.js';
import type { Deps } from './feature.test-d.js';

export const sendReceipt = j.effect('load-order-send-receipt', order, needsOf((_: Deps) => ['mailer']), {
  OrderPlaced: (event, { mailer }) => mailer.send(event.entityId),
});
