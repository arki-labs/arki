import { ignore, j } from '../../../journal.js';
import { order } from '../model.js';

/** A tap: in-process and lossy. A live feed may miss an event while nobody listens. */
export const orderFeed = j.tap('order-feed', order, { OrderPlaced: ignore });
