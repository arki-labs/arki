import { afterEach, describe, expect, it, vi } from 'vitest';

const debugEmailsMock = vi.hoisted(() => vi.fn());
vi.mock('../debug', () => ({ debugEmails: debugEmailsMock }));

// The schema is the load-bearing piece — if it doesn't accept real CF responses
// and reject malformed ones, the safeParse layer in callCloudflareApi is decorative.
import {
  CloudflareResponseSchema,
  cloudflareEmailServiceProvider,
} from './cloudflare-email-service';

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

// ── Driver behavior (issue avocabo/newsletter-ingestion#21 AC: success,
// permanent-bounce, rate-limit 10004, network failure) ──────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

const provider = cloudflareEmailServiceProvider({
  accountId: 'acct-123',
  apiToken: 'token-abc',
});

const payload = {
  to: 'reader@example.com',
  from: 'Avocabo <digest@avocabo.com>',
  subject: 'Your Avocabo digest',
  html: '<p>hi</p>',
  text: 'hi',
  headers: {
    'List-Unsubscribe': '<https://avocabo.com/unsubscribe?digest=dgst_1>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cloudflareEmailServiceProvider.send', () => {
  it('success: POSTs to the account send endpoint with Bearer auth, passes headers through, returns cf:<recipient> id', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        errors: [],
        messages: [],
        result: {
          delivered: ['reader@example.com'],
          permanent_bounces: [],
          queued: [],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider.send(payload);

    expect(result).toEqual({ data: { id: 'cf:reader@example.com' }, error: null });
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/email/sending/send',
    );
    expect(call?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token-abc' });
    const rawBody = call?.[1]?.body;
    if (typeof rawBody !== 'string') throw new TypeError('expected a string request body');
    const body: unknown = JSON.parse(rawBody);
    // RFC-8058 one-click unsubscribe headers must survive the driver 1:1 —
    // CF's custom-header allowlist supports both (D-ING-021).
    expect(body).toMatchObject({ headers: payload.headers });
  });

  it('permanent bounce: every recipient bounced, nothing delivered or queued → error, never a synthetic empty-id success', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        errors: [],
        messages: [],
        result: {
          delivered: [],
          permanent_bounces: ['reader@example.com'],
          queued: [],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider.send(payload);

    // WHY: with CF as the sole provider, an all-bounced send that reports
    // success would make callers mark the email as sent when it went nowhere.
    expect(result.data).toBeNull();
    expect(result.error?.name).toBe('CloudflareEmailServicePermanentBounce');
    expect(result.error?.message).toContain('reader@example.com');
  });

  it('partial bounce: some delivered, some bounced → SUCCESS with the delivered id (documented contract)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        errors: [],
        messages: [],
        result: {
          delivered: ['ok@example.com'],
          permanent_bounces: ['gone@example.com'],
          queued: [],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider.send({ ...payload, to: ['ok@example.com', 'gone@example.com'] });

    // Contract (see provider JSDoc): a send that reached AT LEAST ONE
    // recipient is a success — bounced recipients are debug-logged and
    // CF-suppresses them account-side. Callers needing per-recipient
    // delivery guarantees must send per-recipient (avocabo sends are all
    // single-recipient, so the all-bounced error path covers them).
    expect(result).toEqual({ data: { id: 'cf:ok@example.com' }, error: null });
  });

  it('all-empty result: delivered, queued, AND permanent_bounces empty → error (unknown outcome), never id:"" success', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        success: true,
        errors: [],
        messages: [],
        result: { delivered: [], permanent_bounces: [], queued: [] },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider.send(payload);

    // WHY (L3.review M-2): CF reported success but accounted for no
    // recipient at all — the outcome is unknown. Callers must not
    // markAsSent on a synthetic empty id.
    expect(result.data).toBeNull();
    expect(result.error).toEqual({
      message: 'CF: success response with no delivered, queued, or bounced recipients',
      name: 'CloudflareEmailServiceError',
    });
  });

  it('rate limit: HTTP 429 with a CF error body surfaces code=10004 for retry classification', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(429, {
        success: false,
        errors: [{ code: 10_004, message: 'rate limited' }],
        messages: [],
        result: null,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider.send(payload);

    expect(result.data).toBeNull();
    // WHY: the caller-side taxonomy (avocabo classifySendError) keys on the
    // CF error code — a bare "HTTP 429" would still classify retryable, but
    // code=10004 is the precise signal the issue AC names.
    expect(result.error?.message).toContain('code=10004');
  });

  it('network failure: fetch rejection returns the error, never throws', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider.send(payload);

    expect(result.data).toBeNull();
    expect(result.error).toEqual({
      message: 'fetch failed',
      name: 'CloudflareEmailServiceError',
    });
  });
});

function successResponse(): Response {
  return jsonResponse(200, {
    success: true,
    errors: [],
    messages: [],
    result: { delivered: ['reader@example.com'], permanent_bounces: [], queued: [] },
  });
}

describe('cloudflareEmailServiceProvider dropped-field handling (issue 13 M1)', () => {
  it('debug-logs the dropped-tag COUNT (never content — PII guard) and omits tags from the request body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse());
    vi.stubGlobal('fetch', fetchMock);
    debugEmailsMock.mockClear();

    await provider.send({ ...payload, tags: [{ name: 'category', value: 'digest' }] });

    expect(debugEmailsMock).toHaveBeenCalledWith(
      expect.stringContaining('[cloudflare-email-service] %d tags dropped'),
      1,
    );
    const bodyRaw = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof bodyRaw).toBe('string');
    const body: unknown = JSON.parse(bodyRaw as string);
    expect(Object.keys(body as Record<string, unknown>)).not.toContain('tags');
  });

  it('debug-logs dropped scheduledAt and react', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse());
    vi.stubGlobal('fetch', fetchMock);
    debugEmailsMock.mockClear();

    await provider.send({
      ...payload,
      scheduledAt: '2026-08-01T09:00:00Z',
      react: 'pretend-react-node',
    });

    expect(debugEmailsMock).toHaveBeenCalledWith(
      expect.stringContaining('[cloudflare-email-service] scheduledAt dropped'),
      '2026-08-01T09:00:00Z',
    );
    expect(debugEmailsMock).toHaveBeenCalledWith(
      expect.stringContaining('[cloudflare-email-service] react dropped'),
    );
  });
});
