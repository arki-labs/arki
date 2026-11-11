import { afterEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';
import { orThrow } from '@arki/failure';

import { createDunningCampaignId, dunningCampaignIdSchema } from '../dunning/primitives.js';
import { createRefundId, refundIdSchema } from '../refunds/primitives.js';
import { createTaxConfigId, taxConfigIdSchema } from '../tax/primitives.js';
import { ID_COLUMN_LENGTH } from './id-length.js';
import {
  createCustomerId,
  customerIdSchema,
  createPaymentId,
  createPlanId,
  createSubscriptionId,
  createWebhookId,
  paymentIdSchema,
  planIdSchema,
  subscriptionIdSchema,
  webhookIdSchema,
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

describe('id schemas refuse an id longer than the id column', () => {
  it.each([
    ['plan', createPlanId, planIdSchema],
    ['sub', createSubscriptionId, subscriptionIdSchema],
    ['pay', createPaymentId, paymentIdSchema],
    ['cust', createCustomerId, customerIdSchema],
    ['wh', createWebhookId, webhookIdSchema],
    ['dunning campaign', createDunningCampaignId, dunningCampaignIdSchema],
    ['tax config', createTaxConfigId, taxConfigIdSchema],
    ['refund', createRefundId, refundIdSchema],
  ])('%s id: exactly the column length is accepted, one character more is not', (_name, create, schema) => {
    const id = orThrow(create());
    const fits = id + 'q'.repeat(ID_COLUMN_LENGTH - id.length);
    const tooLong = `${fits}q`;

    expect(schema.safeParse(fits).success).toBe(true);
    expect(schema.safeParse(tooLong).success).toBe(false);
  });

  it('counts characters, not UTF-16 units: 200 emoji fit a varchar(256)', () => {
    const id = `${orThrow(createPlanId())}${'\u{1F600}'.repeat(200)}`;

    expect(id.length).toBeGreaterThan(ID_COLUMN_LENGTH);
    expect(planIdSchema.safeParse(id).success).toBe(true);
  });
});
