/**
 * `can` on real principals: a guest is UNAUTHORIZED and the app never loads a row for it; someone
 * else's order is NOT_FOUND with no auth code (it looks exactly like a missing one); staff pass; a
 * shipped order is FORBIDDEN. Every refusal leaves a debug line an audit hook can use, and a
 * procedure whose contract does not name its policy fails with E008, so `dot explain` cannot
 * show a wrong one.
 */
import { call, ORPCError, os } from '@orpc/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { fakeLog } from '@arki/log/testing';

import type { Order } from './__fixtures__/orders.js';
import type { PrincipalFor } from './pg/types.js';
import type { TestAuth } from './testing/index.js';
import { orderPolicies, ordersOf } from './__fixtures__/orders.js';
import { authTables } from './__fixtures__/tables.js';
import { defineAuth } from './definition.js';
import { AUTH_ERROR_CODES, isAuthError } from './errors.js';
import { guards } from './orpc.js';
import { actingAs, testAuth } from './testing/index.js';

const definition = defineAuth({
  app: { name: 'Shop', key: 'shop' },
  methods: ['password'],
  user: { fields: ['plan'] },
});
type Context = {
  readonly principal: PrincipalFor<typeof definition, typeof authTables> | null;
  readonly orders: ReadonlyMap<string, Order>;
};

const { can } = guards<Context>();
const orderInput = z.object({ id: z.string() });
const base = os.$context<Context>().$meta<{ policy?: string }>({});
const load = vi.fn(({ id }: { id: string }, { orders }: Context) => orders.get(id) ?? null);
const refund = base
  .meta({ policy: 'order.refund' })
  .input(orderInput)
  .use(can(orderPolicies)('order.refund', load))
  .handler(({ context }) => ({ refunded: context.order.id, by: context.principal.user.id }));
const undeclared = base
  .input(orderInput)
  .use(can(orderPolicies)('order.refund', load))
  .handler(() => 'ran');
const mislabelled = base
  .meta({ policy: 'order.view' })
  .input(orderInput)
  .use(can(orderPolicies)('order.refund', load))
  .handler(() => 'ran');

let harness: TestAuth<typeof definition, typeof authTables>;
let ada: NonNullable<Context['principal']>;
let orders: ReadonlyMap<string, Order>;
beforeAll(async () => {
  harness = await testAuth(definition, { tables: authTables, roles: user => (user.plan === 'pro' ? ['staff'] : []) });
  ada = await principalFor('ada@shop.test');
  orders = ordersOf(ada.user.id);
});
afterAll(() => harness.dispose());

async function principalFor(email: string, extra: { plan?: 'free' | 'pro' } = {}) {
  const { headers } = await actingAs(harness.auth, { email, ...extra });
  const principal = await harness.auth.principal(headers);
  if (principal === null) throw new Error(`No principal for ${email}.`);
  return principal;
}

async function failureOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof ORPCError) return { code: error.code, data: error.data, message: error.message };
    throw error;
  }
  return;
}

describe('can', () => {
  it('guest → UNAUTHORIZED with E401, and the loader is not called', async () => {
    load.mockClear();
    expect(await failureOf(() => call(refund, { id: 'ord_open' }, { context: { principal: null, orders } }))).toEqual({
      code: 'UNAUTHORIZED',
      data: { code: AUTH_ERROR_CODES.unauthenticated },
      message: 'Sign in to continue.',
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('another customer → NOT_FOUND with no auth code, the same answer as a missing order', async () => {
    const eve = await principalFor('eve@shop.test');
    const notYours = await failureOf(() => call(refund, { id: 'ord_open' }, { context: { principal: eve, orders } }));
    const missing = await failureOf(() => call(refund, { id: 'ord_none' }, { context: { principal: eve, orders } }));
    expect(notYours).toEqual({ code: 'NOT_FOUND', data: undefined, message: 'order not found' });
    expect(missing).toEqual(notYours);
  });

  it('staff → allowed; the owner → allowed; the handler sees the loaded order', async () => {
    const staff = await principalFor('root@shop.test', { plan: 'pro' });
    await expect(call(refund, { id: 'ord_open' }, { context: { principal: staff, orders } })).resolves.toEqual({
      refunded: 'ord_open',
      by: staff.user.id,
    });
    await expect(call(refund, { id: 'ord_open' }, { context: { principal: ada, orders } })).resolves.toEqual({
      refunded: 'ord_open',
      by: ada.user.id,
    });
  });

  it('shipped → FORBIDDEN with E403', async () => {
    expect(
      await failureOf(() => call(refund, { id: 'ord_shipped' }, { context: { principal: ada, orders } })),
    ).toMatchObject({ code: 'FORBIDDEN', data: { code: AUTH_ERROR_CODES.forbidden } });
  });

  it('a denial logs the policy name, the principal id and the outcome at debug', async () => {
    using logs = fakeLog();
    await failureOf(() => call(refund, { id: 'ord_shipped' }, { context: { principal: ada, orders } }));
    logs.assertLogged({
      level: 'debug',
      category: 'arki:auth',
      fields: { policy: 'order.refund', principalId: ada.user.id, outcome: 'forbidden' },
    });
  });

  it('contract meta that does not name the policy → E008, before anything else runs', async () => {
    load.mockClear();
    for (const procedure of [undeclared, mislabelled]) {
      const error: unknown = await call(procedure, { id: 'ord_open' }, { context: { principal: null, orders } }).catch(
        (error_: unknown) => error_,
      );
      const cause = error instanceof Error && isAuthError(error.cause) ? error.cause : error;
      expect(cause).toMatchObject({ code: AUTH_ERROR_CODES.policyNotDeclared, status: 500 });
    }
    expect(load).not.toHaveBeenCalled();
  });
});
