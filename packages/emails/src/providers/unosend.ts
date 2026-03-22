import { debugEmails } from '../debug';

import type { EmailProvider, SendEmailPayload, SendEmailResult } from './types';

const UNOSEND_API_URL = 'https://www.unosend.com/api/v1/emails';

type UnosendPayload = {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  headers?: Record<string, string>;
  scheduled_at?: string;
};

type UnosendSuccessResponse = { id: string };
type UnosendErrorResponse = { message: string; code?: string };

async function callUnosendApi(
  apiKey: string,
  body: UnosendPayload,
): Promise<SendEmailResult> {
  try {
    const response = await fetch(UNOSEND_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Entity-Ref-ID': `${Date.now()}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = (await response.json().catch(() => ({
        message: `HTTP ${response.status}`,
      }))) as UnosendErrorResponse;

      return {
        data: null,
        error: { message: err.message ?? `HTTP ${response.status}`, name: 'UnosendError' },
      };
    }

    const result = (await response.json()) as UnosendSuccessResponse;
    return { data: { id: result.id }, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { data: null, error: { message, name: 'UnosendError' } };
  }
}

/**
 * Creates an email provider backed by the Unosend REST API.
 *
 * Unosend supports scheduled delivery, up to 100 recipients per batch,
 * and DKIM/SPF/DMARC-verified sending. The `{ data, error }` response
 * shape mirrors Resend's SDK for consistency.
 *
 * @example
 * ```ts
 * unosendProvider({ apiKey: env.UNOSEND_API_KEY, quotaPerMonth: 6_000 })
 * ```
 */
export function unosendProvider(options: {
  /** Unosend API key. */
  apiKey: string;
  /**
   * Monthly send quota for this account tier.
   * Pro plan = 60 000/month at $20.
   * Used by the quota router to select providers.
   */
  quotaPerMonth?: number;
}): EmailProvider {
  return {
    name: 'unosend',
    quotaPerMonth: options.quotaPerMonth,

    async send(payload: SendEmailPayload): Promise<SendEmailResult> {
      debugEmails('[unosend] Sending to=%s subject="%s"', payload.to, payload.subject);

      const body: UnosendPayload = {
        from: payload.from,
        to: Array.isArray(payload.to) ? payload.to : [payload.to],
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        cc: payload.cc
          ? Array.isArray(payload.cc)
            ? payload.cc
            : [payload.cc]
          : undefined,
        bcc: payload.bcc
          ? Array.isArray(payload.bcc)
            ? payload.bcc
            : [payload.bcc]
          : undefined,
        reply_to: payload.replyTo
          ? Array.isArray(payload.replyTo)
            ? payload.replyTo
            : [payload.replyTo]
          : undefined,
        headers: payload.headers,
        scheduled_at: payload.scheduledAt,
      };

      const result = await callUnosendApi(options.apiKey, body);

      if (result.error) {
        debugEmails('[unosend] Send failed: %s', result.error.message);
      } else {
        debugEmails('[unosend] Sent ok id=%s', result.data?.id);
      }

      return result;
    },
  };
}
