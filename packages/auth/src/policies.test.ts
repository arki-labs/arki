/**
 * The decision itself, with no transport: `view` false hides the subject (it must look missing,
 * so ids cannot be probed), the action false forbids it, and a policy that throws is a bug that
 * is rethrown, never turned into a refusal.
 */
import { describe, expect, it } from 'vitest';

import type { Order } from './__fixtures__/orders.js';
import type { AnyPrincipal } from './principal.js';
import { orderPolicies } from './__fixtures__/orders.js';
import { decide, definePolicies, groupOf } from './policies.js';

const principal = (id: string, roles: readonly string[] = []): AnyPrincipal => ({
  user: { id, emailVerified: true },
  session: { id: 'ses_1', createdAt: new Date(0), expiresAt: new Date(0), ipAddress: null, userAgent: null },
  via: 'cookie',
  roles,
});
const order = (status: Order['status']): Order => ({ id: 'ord_1', customerId: 'usr_ada', status });

describe('decide', () => {
  it('view false hides, action false forbids, and the owner or staff pass', async () => {
    await expect(decide(orderPolicies, 'order.refund', principal('usr_eve'), order('open'))).resolves.toEqual({
      allowed: false,
      outcome: 'hidden',
    });
    await expect(decide(orderPolicies, 'order.refund', principal('usr_ada'), order('shipped'))).resolves.toEqual({
      allowed: false,
      outcome: 'forbidden',
    });
    await expect(decide(orderPolicies, 'order.refund', principal('usr_ada'), order('open'))).resolves.toEqual({
      allowed: true,
      subject: order('open'),
    });
    await expect(
      decide(orderPolicies, 'order.refund', principal('usr_staff', ['staff']), order('open')),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('a missing subject is refused as missing; order.view is the view check alone', async () => {
    await expect(decide(orderPolicies, 'order.view', principal('usr_ada'), null)).resolves.toEqual({
      allowed: false,
      outcome: 'missing',
    });
    await expect(decide(orderPolicies, 'order.view', principal('usr_ada'), order('shipped'))).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('a policy that throws is rethrown, not read as a refusal', async () => {
    const broken = definePolicies<{ order: Order }>()({
      order: {
        refund: () => {
          throw new Error('policy bug');
        },
      },
    });
    await expect(decide(broken, 'order.refund', principal('usr_ada'), order('open'))).rejects.toThrow('policy bug');
  });

  it('a group without view goes straight to the action', async () => {
    const open = definePolicies<{ order: Order }>()({ order: { refund: () => Promise.resolve(true) } });
    await expect(decide(open, 'order.refund', principal('usr_eve'), order('open'))).resolves.toMatchObject({
      allowed: true,
    });
  });
});

describe('groupOf', () => {
  it('is the part before the first dot, and refuses a name without one', () => {
    expect(groupOf('order.refund')).toBe('order');
    expect(() => groupOf('order')).toThrow('not a policy name');
  });
});
