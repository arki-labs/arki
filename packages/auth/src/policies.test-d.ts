/**
 * The policy types: a policy name that is not in the tree, a loader that returns the wrong subject
 * and a group that would hide the principal never compile; the handler sees the subject typed; an
 * inline loader's input comes from the procedure.
 */
import { os } from '@orpc/server';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { errorMap } from '@arki/failure/orpc';
import { route, routes, step } from '@arki/http';

import type { AnyPrincipal } from './principal.js';
import { AUTH_FAILURES, AuthenticationRequired } from './boundary-failures.js';
import { authFailureHeaders, authorize, principalFromHeaders } from './http.js';
import { can } from './orpc.js';
import { definePolicies } from './policies.js';
import { authed } from './steps.js';

type Order = { readonly id: string; readonly customerId: string; readonly status: 'open' | 'shipped' };
type User = { readonly id: string; readonly email: string };
type Context = {
  readonly principal: AnyPrincipal | null;
  readonly orders: { byId(id: string): Promise<Order | null> };
};

const orderPolicies = definePolicies<{ order: Order }>()({
  order: {
    view: ({ principal, order }) => principal.roles.includes('staff') || order.customerId === principal.user.id,
    refund: ({ order }) => order.status !== 'shipped',
  },
});

const refund = os
  .$context<Context>()
  .errors(errorMap(...AUTH_FAILURES))
  .$meta<{ policy?: string }>({})
  .meta({ policy: 'order.refund' })
  .input(z.object({ id: z.string() }));

const source = { principal: () => Promise.resolve(null) };
const refundHandler = () => ({ id: '1' });
const refundRoute = route.post('/orders/:id/refund', {
  id: 'refund',
  failures: AUTH_FAILURES,
  output: z.object({ id: z.string() }),
});

describe('policy typing', () => {
  it('unknown policy name does not compile', () => {
    // @ts-expect-error -- 'order.refnd' is not a policy of the tree.
    can(orderPolicies)('order.refnd', () => null);
    // @ts-expect-error -- 'order.refnd' is not a policy of the tree.
    authorize(orderPolicies)('order.refnd', () => null, refundHandler);
  });

  it('load must return the policy subject, and the handler sees it typed', () => {
    const user: User = { id: 'usr_1', email: 'a@b.test' };
    // @ts-expect-error -- a User is not the Order that order.refund checks.
    can(orderPolicies)('order.refund', () => user);
    refund
      .use(can(orderPolicies)('order.refund', ({ id }: { id: string }, { orders }) => orders.byId(id)))
      .handler(({ context }) => {
        expectTypeOf(context.order).toEqualTypeOf<Order>();
        expectTypeOf(context.principal).toEqualTypeOf<AnyPrincipal>();
      });
  });

  it('a group named principal does not compile', () => {
    // @ts-expect-error -- the group key `principal` would hide the principal in the policy argument.
    definePolicies<{ principal: Order }>()({ principal: { view: () => true } });
  });

  it('inline loader input is inferred from the procedure', () => {
    refund
      .use(
        can(orderPolicies)('order.refund', (input, context) => {
          expectTypeOf(input).toEqualTypeOf<{ id: string }>();
          return context.orders.byId(input.id);
        }),
      )
      .handler(({ context }) => context.order.id);
  });

  it('the loader sees context keys added before can() by other middleware', () => {
    os.$context<Context>()
      .errors(errorMap(...AUTH_FAILURES))
      .use(({ next }) =>
        next({ context: { usecases: { byId: (_id: string) => Promise.resolve<Order | null>(null) } } }),
      )
      .input(z.object({ id: z.string() }))
      .use(can(orderPolicies)('order.refund', ({ id }, { usecases }) => usecases.byId(id)))
      .handler(({ context }) => context.order.status);
  });

  it('authorize: the bundle must derive principal, and the handler sees the subject', () => {
    routes()
      .use(step(principalFromHeaders(source), { failureHeaders: authFailureHeaders }))
      .bind(
        refundRoute,
        authorize(orderPolicies)(
          'order.refund',
          ({ params }) => {
            expectTypeOf(params.id).toEqualTypeOf<string>();
            return null;
          },
          (_input, ctx) => {
            expectTypeOf(ctx.order).toEqualTypeOf<Order>();
            return { id: ctx.order.id };
          },
        ),
        { failureHeaders: authFailureHeaders },
      );
  });
});

it('HTTP auth steps require their inferred failures on the selected route', () => {
  const privateRoute = route.get('/private', { id: 'private', output: z.string() });
  routes()
    .use(step(principalFromHeaders(source)))
    // @ts-expect-error the principal step emits undeclared auth failures.
    .bind(privateRoute, () => 'unreachable');
  const partial = route.get('/partial', { id: 'partial', failures: [AuthenticationRequired], output: z.string() });
  routes()
    .use(step(principalFromHeaders(source)))
    .use(step(authed))
    // @ts-expect-error resolving the principal can also return limiter/store/defect failures.
    .bind(partial, () => 'unreachable');
  const declared = route.get('/declared', { id: 'declared', failures: AUTH_FAILURES });
  routes()
    .use(step(principalFromHeaders(source)))
    .use(step(authed))
    .bind(declared, (_input, context) => {
      expectTypeOf(context.principal).toEqualTypeOf<AnyPrincipal>();
    });
  routes()
    .use(step(principalFromHeaders(source)))
    .bind(declared, (_input, context) => {
      expectTypeOf(context.principal).toEqualTypeOf<AnyPrincipal | null>();
    });
});
