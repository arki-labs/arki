import { describe, expect, it } from 'vitest';

import { mapStripeEventType } from './stripe-event-types.js';

describe('mapStripeEventType', () => {
  it('maps refunds and disputes to events the webhook handler records, instead of ignoring them', () => {
    expect(mapStripeEventType('charge.refunded')).toBe('payment.refunded');
    expect(mapStripeEventType('charge.dispute.created')).toBe('payment.dispute_created');
    expect(mapStripeEventType('refund.created')).toBe('refund.updated');
    expect(mapStripeEventType('refund.updated')).toBe('refund.updated');
  });

  it('still ignores an event type it does not model', () => {
    expect(mapStripeEventType('charge.captured')).toBeNull();
    expect(mapStripeEventType('constructor')).toBeNull();
  });
});
