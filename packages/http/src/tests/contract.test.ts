/**
 * Contract factories: shape, defaults, and the path-param type machinery.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ParamsOf } from '../contract.js';
import { route } from '../contract.js';

describe('route factories', () => {
  it('build http contracts with the declared method and carried schemas', () => {
    const output = z.object({ id: z.string() });
    const contract = route.get('/orders/:id', { id: 'orders.get', summary: 'one order', output });

    expect(contract.kind).toBe('http');
    expect(contract.method).toBe('GET');
    expect(contract.path).toBe('/orders/:id');
    expect(contract.id).toBe('orders.get');
    expect(contract.summary).toBe('one order');
    expect(contract.output).toBe(output);
    expect(contract.query).toBeUndefined();
  });

  it('covers all five methods', () => {
    expect(route.post('/x', { id: 'a' }).method).toBe('POST');
    expect(route.put('/x', { id: 'b' }).method).toBe('PUT');
    expect(route.patch('/x', { id: 'c' }).method).toBe('PATCH');
    // eslint-disable-next-line drizzle/enforce-delete-with-where -- route.delete is an HTTP contract factory, not a query builder
    expect(route.delete('/x', { id: 'd' }).method).toBe('DELETE');
  });

  it('builds sse contracts as GET with an event schema', () => {
    const event = z.object({ type: z.string() });
    const contract = route.sse('/progress', { id: 'progress', event, heartbeatMs: 500 });

    expect(contract.kind).toBe('sse');
    expect(contract.method).toBe('GET');
    expect(contract.event).toBe(event);
    expect(contract.heartbeatMs).toBe(500);
  });
});

describe('path-param typing', () => {
  it('ParamsOf extracts every :param as a string field', () => {
    const params: ParamsOf<'/orders/:id/items/:itemId'> = { id: 'o1', itemId: 'i1' };
    expect(params.id).toBe('o1');

    // @ts-expect-error — "ghost" is not a declared path parameter
    const bad: ParamsOf<'/orders/:id'> = { id: 'o1', ghost: 'x' };
    void bad;
  });
});
