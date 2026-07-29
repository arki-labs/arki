import { z } from '@arki/contracts';

import { debugEmails } from '../debug';

import type { EmailProvider, SendEmailPayload, SendEmailResult } from './types';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

type CloudflareAttachment = {
  content: string;
  filename: string;
  type?: string;
  disposition?: string;
};

type CloudflarePayload = {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  headers?: Record<string, string>;
  attachments?: CloudflareAttachment[];
};

type CloudflareSuccessResponse = {
  success: true;
  errors: unknown[];
  messages: unknown[];
  result: {
    delivered: string[];
    permanent_bounces: string[];
    queued: string[];
  };
};

type CloudflareErrorResponse = {
  success: false;
  errors: Array<{ code: number; message: string }>;
  messages: unknown[];
  result: unknown;
};

type CloudflareResponse = CloudflareSuccessResponse | CloudflareErrorResponse;

// Runtime-validation schemas mirroring the type aliases above. Used by callCloudflareApi
// to safeParse the HTTP response body — if Cloudflare's beta API changes shape or a proxy
// mangles the body, the parser surfaces a structured error instead of letting downstream
// code throw a TypeError on `parsed.result.delivered[0]`. Mirror shape EXACTLY to keep the
// Equals guard below honest (plan-eng-review F4, 2026-05-29).
const CloudflareErrorEntry = z.object({
  code: z.number(),
  message: z.string(),
});

const CloudflareSuccessSchema = z.object({
  success: z.literal(true),
  errors: z.array(z.unknown()),
  messages: z.array(z.unknown()),
  result: z.object({
    delivered: z.array(z.string()),
    permanent_bounces: z.array(z.string()),
    queued: z.array(z.string()),
  }),
});

const CloudflareErrorSchema = z.object({
  success: z.literal(false),
  errors: z.array(CloudflareErrorEntry),
  messages: z.array(z.unknown()),
  result: z.unknown(),
});

export const CloudflareResponseSchema = z.union([CloudflareSuccessSchema, CloudflareErrorSchema]);

// Compile-time guard: if CloudflareResponseSchema and CloudflareResponse drift
// apart, the assignment below produces a TS error. This catches the case where
// the executor wrote a schema stricter or looser than the existing type alias
// (plan-eng-review F4, 2026-05-29).
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type _CheckCloudflareResponseSchemaMatchesType = Equals<
  z.infer<typeof CloudflareResponseSchema>,
  CloudflareResponse
> extends true
  ? true
  : never;
const _checkCloudflareResponseSchemaMatchesType: _CheckCloudflareResponseSchemaMatchesType = true;
void _checkCloudflareResponseSchemaMatchesType;

function toArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function firstReplyTo(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

async function callCloudflareApi(
  accountId: string,
  apiToken: string,
  body: CloudflarePayload,
): Promise<SendEmailResult> {
  try {
    const response = await fetch(
      `${CLOUDFLARE_API_BASE}/accounts/${accountId}/email/sending/send`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify(body),
      },
    );

    const raw = await response.json().catch(() => null);
    const parseResult = raw != null ? CloudflareResponseSchema.safeParse(raw) : null;

    if (!parseResult || !parseResult.success) {
      // No body, non-JSON body, or a shape we don't recognize.
      const errorMessage = !response.ok
        ? `HTTP ${response.status}`
        : !parseResult
          ? 'CF: empty or non-JSON response body'
          : 'CF: response shape did not match CloudflareResponseSchema';
      return {
        data: null,
        error: { message: errorMessage, name: 'CloudflareEmailServiceError' },
      };
    }

    const parsed = parseResult.data;

    if (parsed.success === false) {
      // A CF-shaped error body is more precise than the bare HTTP status —
      // callers classify retryability by CF error code (e.g. 10004 rate-limit).
      const errorMessage = parsed.errors[0]
        ? `${parsed.errors[0].message} (code=${parsed.errors[0].code})`
        : `HTTP ${response.status}`;
      return {
        data: null,
        error: { message: errorMessage, name: 'CloudflareEmailServiceError' },
      };
    }

    if (!response.ok) {
      // Defensive: HTTP error status with a success-shaped body.
      return {
        data: null,
        error: { message: `HTTP ${response.status}`, name: 'CloudflareEmailServiceError' },
      };
    }

    if (parsed.result.permanent_bounces.length > 0) {
      debugEmails(
        '[cloudflare-email-service] Permanent bounces: %o',
        parsed.result.permanent_bounces,
      );
    }

    // Every recipient permanently bounced and nothing was delivered or queued:
    // the message went nowhere. Surface as an error so callers (send-digest,
    // auth email throws) treat it as a failed send instead of logging a
    // synthetic empty id as success.
    if (
      parsed.result.delivered.length === 0 &&
      parsed.result.queued.length === 0 &&
      parsed.result.permanent_bounces.length > 0
    ) {
      return {
        data: null,
        error: {
          message: `permanent bounce: ${parsed.result.permanent_bounces.join(', ')}`,
          name: 'CloudflareEmailServicePermanentBounce',
        },
      };
    }

    // Success response accounting for NO recipient at all (delivered, queued,
    // AND permanent_bounces all empty — the bounce guard above already caught
    // the bounced case): the outcome is unknown. Error instead of a synthetic
    // empty-id success, per the JSDoc contract (L3.review M-2).
    if (parsed.result.delivered.length === 0 && parsed.result.queued.length === 0) {
      return {
        data: null,
        error: {
          message: 'CF: success response with no delivered, queued, or bounced recipients',
          name: 'CloudflareEmailServiceError',
        },
      };
    }

    // CF Email Service returns per-recipient delivery status, not a message ID.
    // Synthesise an ID from delivered[0] so downstream consumers have something to log.
    const id = parsed.result.delivered[0]
      ? `cf:${parsed.result.delivered[0]}`
      : `cf-queued:${parsed.result.queued[0]}`;

    return { data: { id }, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { data: null, error: { message, name: 'CloudflareEmailServiceError' } };
  }
}

/**
 * Creates an email provider backed by Cloudflare Email Service (Email Sending REST API).
 *
 * Cloudflare Email Service is currently **in beta** (as of 2026-05-28). Features and
 * pricing may change before GA. Workers Paid plan ($5/mo) is required for outbound;
 * Email Routing (inbound) is unlimited and free.
 *
 * **Pricing as of 2026-05-28:** 3 000 emails/month included on Workers Paid, then
 * $0.35 per 1 000 emails overage.
 *
 * **Message size limit:** 5 MiB total including attachments (smaller than SES's 40 MiB
 * and Resend's 25 MiB — keep digest HTML lean).
 *
 * **API differences from Resend/Unosend to be aware of:**
 * - Responds with per-recipient delivery status (`delivered`, `permanent_bounces`,
 *   `queued`) rather than a single message ID. This provider synthesises an ID
 *   from the first delivered recipient (`cf:recipient@example.com`) so the
 *   downstream contract still has something to log.
 * - `reply_to` is a single address (not an array) per the docs.
 * - Attachments must be base64-encoded in the request body.
 * - Per-recipient outcomes are NOT individually surfaced: a send that reached
 *   AT LEAST ONE recipient (delivered or queued) returns success with the
 *   first delivered/queued recipient's synthetic id; permanently bounced
 *   recipients are debug-logged only (CF also suppresses them account-side).
 *   Only when EVERY recipient permanently bounced does `send` return an
 *   error (`CloudflareEmailServicePermanentBounce`). Callers that need
 *   per-recipient delivery guarantees must send one recipient per call.
 *
 * @example
 * ```ts
 * cloudflareEmailServiceProvider({
 *   accountId: env.CLOUDFLARE_ACCOUNT_ID,
 *   apiToken: env.CLOUDFLARE_EMAIL_API_TOKEN,
 *   quotaPerMonth: 3_000, // free tier on Workers Paid
 * })
 * ```
 */
export function cloudflareEmailServiceProvider(options: {
  /** Cloudflare account ID (32-char hex). */
  accountId: string;
  /** Cloudflare API token with `Email Service: Edit` permission. */
  apiToken: string;
  /**
   * Monthly send quota for this Cloudflare account.
   * Workers Paid plan includes 3 000/month free; pay-as-you-go beyond.
   * Used by the quota router to select providers.
   */
  quotaPerMonth?: number;
}): EmailProvider {
  return {
    name: 'cloudflare-email-service',
    quotaPerMonth: options.quotaPerMonth,

    async send(payload: SendEmailPayload): Promise<SendEmailResult> {
      debugEmails(
        '[cloudflare-email-service] Sending to=%s subject="%s"',
        payload.to,
        payload.subject,
      );

      // The CF Email Sending API has no tag, schedule, or react concept —
      // make the drops visible in debug logs (issue 13 M1). Log the COUNT
      // only, never tag content: `payload.tags` may carry PII from a future
      // caller and this is a shared lib (plan-review gate fold 1). The
      // length guard keeps an empty `[]` from emitting a misleading line.
      if (payload.tags?.length) {
        debugEmails('[cloudflare-email-service] %d tags dropped (no CF tag support)', payload.tags.length);
      }
      if (payload.scheduledAt !== undefined) {
        debugEmails(
          '[cloudflare-email-service] scheduledAt dropped (no CF scheduled delivery): %s',
          payload.scheduledAt,
        );
      }
      if (payload.react != null) {
        debugEmails('[cloudflare-email-service] react dropped (pre-render to html; react is Resend-only)');
      }

      const body: CloudflarePayload = {
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        cc: toArray(payload.cc),
        bcc: toArray(payload.bcc),
        reply_to: firstReplyTo(payload.replyTo),
        headers: payload.headers,
      };

      const result = await callCloudflareApi(options.accountId, options.apiToken, body);

      if (result.error) {
        debugEmails('[cloudflare-email-service] Send failed: %s', result.error.message);
      } else {
        debugEmails('[cloudflare-email-service] Sent ok id=%s', result.data?.id);
      }

      return result;
    },
  };
}
