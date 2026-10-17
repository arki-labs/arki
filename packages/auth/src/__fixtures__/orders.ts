/**
 * The worked example the policy tests share: staff and the order's customer may see an order, and
 * an order may be refunded until it ships.
 */
import { definePolicies } from '../policies.js';

export type Order = { readonly id: string; readonly customerId: string; readonly status: 'open' | 'shipped' };

export const orderPolicies = definePolicies<{ order: Order }>()({
  order: {
    view: ({ principal, order }) => principal.roles.includes('staff') || order.customerId === principal.user.id,
    refund: ({ order }) => order.status !== 'shipped',
  },
});

/** Ada's open order and her shipped one, by id. */
export function ordersOf(customerId: string): ReadonlyMap<string, Order> {
  return new Map<string, Order>([
    ['ord_open', { id: 'ord_open', customerId, status: 'open' }],
    ['ord_shipped', { id: 'ord_shipped', customerId, status: 'shipped' }],
  ]);
}
