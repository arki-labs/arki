import { afterEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';

import {
  createCustomerId,
  createPaymentId,
  createPlanId,
  createSubscriptionId,
  createWebhookId,
} from './primitives.js';
import { userIdSchema } from './user-id.js';

describe('id factories', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['plan', createPlanId],
    ['sub', createSubscriptionId],
    ['pay', createPaymentId],
    ['cust', createCustomerId],
    ['wh', createWebhookId],
  ])('%s ids are returned with their prefix when entropy works', (prefix, create) => {
    const id = create();
    expect(typeof id === 'string' && id.startsWith(prefix)).toBe(true);
  });

  it.each([
    ['createPlanId', createPlanId],
    ['createSubscriptionId', createSubscriptionId],
    ['createPaymentId', createPaymentId],
    ['createCustomerId', createCustomerId],
    ['createWebhookId', createWebhookId],
  ])('%s returns contracts.random_source_unavailable when no secure random source exists, never a weak id', (_name, create) => {
    vi.stubGlobal('crypto', null);
    const result = create();
    expect(RandomSourceUnavailable.is(result)).toBe(true);
    expect(result).toMatchObject({ code: 'contracts.random_source_unavailable' });
  });
});

describe('userIdSchema', () => {
  it('takes a usr_ id and refuses one holding U+0000, which no user_id column can store', () => {
    expect(userIdSchema.safeParse('usr_alice').success).toBe(true);
    expect(userIdSchema.safeParse('usr_a\u0000b').success).toBe(false);
    expect(userIdSchema.safeParse('cus_alice').success).toBe(false);
  });
});
