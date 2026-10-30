import { ignore, j } from '../../../journal.js';
import { order } from '../model.js';

/** An inline read model: it commits in the same transaction as the event. */
export const orderCount = j.projection('order-count', order, {
  OrderPlaced: ignore,
});
