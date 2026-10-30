import { cancelOrder } from '../usecases/cancel-order.js';
import { placeOrder } from '../usecases/place-order.js';

/** A procedure imports the commands and calls `context.run(command, input)`; no list registers them. */
export const ordersRpc = { place: placeOrder, cancel: cancelOrder };
