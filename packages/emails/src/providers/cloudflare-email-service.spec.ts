import { describe, expect, it } from 'vitest';

// The schema is the load-bearing piece — if it doesn't accept real CF responses
// and reject malformed ones, the safeParse layer in callCloudflareApi is decorative.
import { CloudflareResponseSchema } from './cloudflare-email-service';

describe('CloudflareResponseSchema', () => {
  it('accepts a valid success response', () => {
    const valid = {
      success: true,
      errors: [],
      messages: [],
      result: {
        delivered: ['msg-id-123'],
        permanent_bounces: [],
        queued: [],
      },
    };
    const result = CloudflareResponseSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('accepts a valid error response', () => {
    const valid = {
      success: false,
      errors: [{ code: 1234, message: 'Invalid recipient address' }],
      messages: [],
      result: null,
    };
    const result = CloudflareResponseSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success && result.data.success === false) {
      expect(result.data.errors[0]?.message).toBe('Invalid recipient address');
    }
  });

  it('rejects a malformed response (missing required `success` discriminator)', () => {
    const invalid = { result: { delivered: ['msg-id-456'] } };
    const result = CloudflareResponseSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
