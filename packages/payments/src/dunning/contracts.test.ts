import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';
import { parse } from '@arki/schema';

import {
  createCustomerSegmentInputSchema,
  createDunningCampaignInputSchema,
  createDunningTemplateInputSchema,
  segmentCriteriaSchema,
} from './contracts.js';
import { createDunningCampaignId } from './primitives.js';

describe('segmentCriteriaSchema totalSpent', () => {
  it('keeps the range as { amount, currency } JSON, because criteria are stored in a jsonb column', () => {
    const parsed = segmentCriteriaSchema.parse({
      totalSpent: { min: { amount: '100', currency: 'EUR' }, max: { amount: '1000.50', currency: 'EUR' } },
    });
    expect(parsed.totalSpent).toEqual({
      min: { amount: '100.00', currency: 'EUR' },
      max: { amount: '1000.50', currency: 'EUR' },
    });
  });

  it('rejects a range whose bounds use different currencies: totals are only summed within one currency', () => {
    const result = segmentCriteriaSchema.safeParse({
      totalSpent: { min: { amount: '100', currency: 'EUR' }, max: { amount: '1000', currency: 'USD' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative bound and a bare number with no currency', () => {
    expect(segmentCriteriaSchema.safeParse({ totalSpent: { min: { amount: '-1', currency: 'EUR' } } }).success).toBe(
      false,
    );
    expect(segmentCriteriaSchema.safeParse({ totalSpent: { min: 100 } }).success).toBe(false);
  });
});

// Postgres refuses U+0000 in text (22021) and in jsonb (22P05), and an int4 above 2^31 - 1 (22003). The contract
// must refuse them first, so a route answers 400 instead of a raw database error.
/** A segment whose criteria carry these custom attributes, through the create contract. */
function segmentWith(customAttributes: Record<string, unknown>) {
  return parse(createCustomerSegmentInputSchema, {
    name: 'Late payers',
    type: 'risk_based',
    criteria: { customAttributes },
  });
}

describe('the contracts refuse what the columns refuse', () => {
  const NUL = '\u0000';
  const communication = { channel: 'email' as const, content: 'Please update your card', variables: [] };
  const step = { name: 'Step 1', stepNumber: 1, delayHours: 0, communication };
  const template = { campaignId: orThrow(createDunningCampaignId()), ...step };
  const segment = { name: 'Late payers', type: 'risk_based' as const, criteria: {} };
  const campaign = {
    name: 'Recover failed payments',
    type: 'payment_failed' as const,
    trigger: { type: 'payment_failure' as const, conditions: {} },
    settings: {
      enabled: true,
      priority: 1,
      cooldownPeriod: 24,
      maxExecutionsPerCustomer: 3,
      stopOnPaymentSuccess: true,
      respectUnsubscribe: true,
      businessHoursOnly: false,
    },
    templates: [step],
  };

  it('NUL in a text field returns schema.invalid_input for templates, segments and campaigns', () => {
    for (const refused of [
      parse(createDunningTemplateInputSchema, { ...template, name: `Step${NUL}1` }),
      parse(createDunningTemplateInputSchema, {
        ...template,
        communication: { ...communication, content: `Pay${NUL}` },
      }),
      parse(createCustomerSegmentInputSchema, { ...segment, description: `Late${NUL}` }),
      parse(createDunningCampaignInputSchema, { ...campaign, name: `Recover${NUL}` }),
    ]) {
      expect(refused).toMatchObject({ code: 'schema.invalid_input' });
    }
    expect(parse(createDunningTemplateInputSchema, template)).toMatchObject({ name: 'Step 1' });
  });

  it('NUL in a key or a value of stored JSON returns schema.invalid_input', () => {
    expect(segmentWith({ plan: { tier: `gold${NUL}` } })).toMatchObject({ code: 'schema.invalid_input' });
    expect(segmentWith({ [`pl${NUL}an`]: 'gold' })).toMatchObject({ code: 'schema.invalid_input' });
    // Text that spells the escape is not a NUL character and is stored as written
    expect(segmentWith({ note: String.raw`\u0000` })).toMatchObject({
      criteria: { customAttributes: { note: String.raw`\u0000` } },
    });
  });

  it('a step number or delay above 2^31 - 1 returns schema.invalid_input; 2^31 - 1 itself is accepted', () => {
    const tooBig = 2_147_483_648;
    for (const refused of [
      parse(createDunningCampaignInputSchema, { ...campaign, templates: [{ ...step, delayHours: tooBig }] }),
      parse(createDunningCampaignInputSchema, { ...campaign, templates: [{ ...step, stepNumber: tooBig }] }),
      parse(createDunningTemplateInputSchema, { ...template, delayHours: tooBig }),
      parse(createCustomerSegmentInputSchema, { ...segment, updateFrequency: tooBig }),
    ]) {
      expect(refused).toMatchObject({ code: 'schema.invalid_input' });
    }
    expect(
      parse(createDunningCampaignInputSchema, {
        ...campaign,
        templates: [{ ...step, stepNumber: tooBig - 1, delayHours: tooBig - 1 }],
      }),
    ).toMatchObject({ templates: [{ stepNumber: tooBig - 1, delayHours: tooBig - 1 }] });
  });
});
