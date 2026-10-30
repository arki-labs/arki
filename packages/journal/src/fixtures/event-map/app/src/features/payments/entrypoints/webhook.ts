import type { placeOrder } from '../../orders/usecases/place-order.js';
import * as charges from '../usecases/charge.js';

/**
 * A namespace import keeps every command of the module, so both commands of `charge.ts` are edges. The type-only
 * import above is not an edge: it never runs the command.
 */
export const paymentsWebhook = { charges, placed: undefined as undefined | typeof placeOrder };
