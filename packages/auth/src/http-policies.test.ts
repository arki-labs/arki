/**
 * `authorize` through a real `@arki/http` bundle: the same matrix as oRPC. A guest is 401 and the
 * app never loads a row for it; someone else's order is 404 exactly like a missing one; staff
 * pass; a shipped order is 403.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { buildEngine, route, routes } from '@arki/http';

import type { Order } from './__fixtures__/orders.js';
import type { TestAuth } from './testing/index.js';
import { orderPolicies, ordersOf } from './__fixtures__/orders.js';
import { authTables } from './__fixtures__/tables.js';
import { AccessDenied, AUTH_FAILURES, AuthenticationRequired, ResourceMissing } from './boundary-failures.js';
import { defineAuth } from './definition.js';
import { authFailureHeaders, authorize, withOptionalPrincipal } from './http.js';
import { actingAs, testAuth } from './testing/index.js';

const definition = defineAuth({
  app: { name: 'Shop', key: 'shop' },
  methods: ['password'],
  user: { fields: ['plan'] },
});

const refundOrder = route.post('/orders/:id/refund', {
  failures: AUTH_FAILURES,
  id: 'orders.refund',
  output: z.object({ refunded: z.string() }),
});

let harness: TestAuth<typeof definition, typeof authTables>;
let fetchHttp: (request: Request) => Promise<Response>;
let ada: Headers;
const load = vi.fn<(id: string) => Order | null>();
beforeAll(async () => {
  harness = await testAuth(definition, { tables: authTables, roles: user => (user.plan === 'pro' ? ['staff'] : []) });
  const { auth } = harness;
  const signedIn = await actingAs(auth, { email: 'ada@shop.test' });
  ada = signedIn.headers;
  const adaPrincipal = await auth.principal(ada);
  const orders = ordersOf(adaPrincipal?.user.id ?? '');
  load.mockImplementation(id => orders.get(id) ?? null);
  const engine = buildEngine([
    routes()
      .derive(withOptionalPrincipal(auth))
      .bind(
        refundOrder,
        authorize(orderPolicies)(
          'order.refund',
          ({ params }) => load(params.id),
          (_input, { order }) => ({ refunded: order.id }),
        ),
        { failureHeaders: authFailureHeaders },
      ),
  ]);
  fetchHttp = request => Promise.resolve(engine.fetch(request));
});
afterAll(() => harness.dispose());

const refund = (id: string, headers?: Headers) =>
  fetchHttp(new Request(`http://localhost/orders/${id}/refund`, { method: 'POST', headers }));

describe('authorize', () => {
  it('guest → 401 with E401, and the loader is not called', async () => {
    load.mockClear();
    const response = await refund('ord_open');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(await response.json()).toMatchObject({ error: { code: AuthenticationRequired.code } });
    expect(load).not.toHaveBeenCalled();
  });

  it('another customer → 404, the same answer as a missing order', async () => {
    const { headers } = await actingAs(harness.auth, { email: 'eve@shop.test' });
    const notYours = await refund('ord_open', headers);
    const missing = await refund('ord_none', headers);
    expect(notYours.status).toBe(404);
    expect(missing.status).toBe(404);
    const [notYoursBody, missingBody] = [await notYours.json(), await missing.json()];
    expect(notYoursBody).toMatchObject({ error: { code: ResourceMissing.code } });
    expect(notYoursBody).toEqual(missingBody);
  });

  it('staff → 200; the owner → 200', async () => {
    const { headers } = await actingAs(harness.auth, { email: 'root@shop.test', plan: 'pro' });
    const byStaff = await refund('ord_open', headers);
    expect(byStaff.status).toBe(200);
    expect(await byStaff.json()).toEqual({ refunded: 'ord_open' });
    await expect(refund('ord_open', ada)).resolves.toHaveProperty('status', 200);
  });

  it('shipped → 403 with E403', async () => {
    const response = await refund('ord_shipped', ada);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: AccessDenied.code } });
  });
});
