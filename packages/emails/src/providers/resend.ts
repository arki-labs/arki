import { Resend } from 'resend';

import { debugEmails } from '../debug';

import type { EmailProvider } from './types';

/**
 * Creates an email provider backed by the Resend SDK.
 *
 * @example
 * ```ts
 * resendProvider({ apiKey: env.RESEND_API_KEY, quotaPerMonth: 3_000 })
 * ```
 */
export function resendProvider(options: {
  /** Resend API key (starts with `re_`). */
  apiKey: string;
  /**
   * Monthly send quota for this account tier.
   * Free tier = 3 000, Pro = 50 000+.
   * Used by the quota router to select providers.
   */
  quotaPerMonth?: number;
}): EmailProvider {
  const client = new Resend(options.apiKey);

  return {
    name: 'resend',
    quotaPerMonth: options.quotaPerMonth,

    async send(payload) {
      debugEmails('[resend] Sending to=%s subject="%s"', payload.to, payload.subject);

      const { data, error } = await client.emails.send({
        to: payload.to,
        from: payload.from,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        react: payload.react as never,
        cc: payload.cc,
        bcc: payload.bcc,
        replyTo: payload.replyTo,
        headers: payload.headers,
        tags: payload.tags,
        scheduledAt: payload.scheduledAt,
      });

      if (error) {
        debugEmails('[resend] Send failed: %s', error.message);
        return { data: null, error: { message: error.message, name: 'ResendError' } };
      }

      debugEmails('[resend] Sent ok id=%s', data?.id);
      return { data: { id: data?.id ?? '' }, error: null };
    },
  };
}
