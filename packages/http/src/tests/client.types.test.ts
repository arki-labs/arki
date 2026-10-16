/**
 * Compile-time contract of the typed client: input and output types come
 * from the route contract, written once. A wrong input must not compile —
 * that is the whole point of sharing the contract with the server.
 */

import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { ClientInput } from '../client.js';
import { createClient } from '../client.js';
import { route } from '../contract.js';

const isoDate = z.codec(z.iso.datetime(), z.date(), {
  decode: text => new Date(text),
  encode: date => date.toISOString(),
});

const Order = z.object({ id: z.string(), placedAt: isoDate, total: z.number() });

const getOrder = route.get('/orders/:id', { id: 'orders.get', output: Order });
const listOrders = route.get('/orders', {
  id: 'orders.list',
  query: z.object({ status: z.enum(['open', 'shipped']).optional() }),
  output: z.array(Order),
});
const placeOrder = route.post('/orders', { id: 'orders.place', body: z.object({ total: z.number() }), output: Order });
const download = route.get('/orders/:id/pdf', { id: 'orders.pdf' });

const orders = createClient(
  { getOrder, listOrders, placeOrder, download },
  { baseUrl: 'https://api.example.com', fetch: () => Promise.resolve(Response.json({})) },
);

/** Calls are only type-checked, never run. */
const typeOnly = (): void => {
  // @ts-expect-error -- the path has :id, so params are required
  void orders.getOrder();
  // @ts-expect-error -- params must name the path's parameters
  void orders.getOrder({ params: { orderId: 'o1' } });
  // @ts-expect-error -- the query enum has no 'lost'
  void orders.listOrders({ query: { status: 'lost' } });
  // @ts-expect-error -- the body total is a number
  void orders.placeOrder({ body: { total: '12' } });
  // @ts-expect-error -- a SSE contract is not a JSON route
  createClient(route.sse('/ticks', { id: 'ticks', event: z.number() }), { baseUrl: '' });
  // Every query field is optional, so the input can be left out.
  void orders.listOrders();
};

describe('createClient types', () => {
  it('resolves to the output schema output type', () => {
    expectTypeOf(orders.getOrder).returns.resolves.toEqualTypeOf<z.output<typeof Order>>();
    expectTypeOf(orders.listOrders).returns.resolves.toEqualTypeOf<z.output<typeof Order>[]>();
    // The codec's decoded side, not its wire string.
    expectTypeOf(orders.getOrder).returns.resolves.toHaveProperty('placedAt').toEqualTypeOf<Date>();
    // No output schema: the raw Response.
    expectTypeOf(orders.download).returns.resolves.toEqualTypeOf<Response>();
  });

  it('types input from the path, query and body', () => {
    expectTypeOf<ClientInput<typeof getOrder>>().toEqualTypeOf<{ readonly params: Readonly<Record<'id', string>> }>();
    expectTypeOf<ClientInput<typeof placeOrder>>().toEqualTypeOf<{ readonly body: { total: number } }>();
  });

  it('rejects a wrong input at compile time', () => {
    expectTypeOf(typeOnly).toBeFunction();
  });
});
