import type { EmailProvider } from './types';
import { debugEmails } from '../debug';

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
  // Lazy: `resend` is an optional peer dependency, loaded on the first send.
  const loadClient = async () => {
    const { Resend } = await import('resend');
    return new Resend(options.apiKey);
  };
  let client: ReturnType<typeof loadClient> | undefined;
  const getClient = () => (client ??= loadClient());

  return {
    name: 'resend',
    quotaPerMonth: options.quotaPerMonth,

    async send(payload) {
      debugEmails.debug('[resend] Sending to={to} subject="{subject}"', { to: payload.to, subject: payload.subject });

      try {
        const { data, error } = await (
          await getClient()
        ).emails.send({
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
          debugEmails.debug('[resend] Send failed: {failed}', { failed: error.message });
          return { data: null, error: { message: error.message, name: 'ResendError' } };
        }

        debugEmails.debug('[resend] Sent ok id={id}', { id: data?.id });
        return { data: { id: data?.id ?? '' }, error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        debugEmails.debug('[resend] Send threw: {failed}', { failed: message });
        return { data: null, error: { message, name: 'ResendError' } };
      }
    },
  };
}
