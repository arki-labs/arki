import { debugEmails } from '../debug';
import { quotaRouter } from '../providers/quota-router';
import type { EmailProvider, SendEmailPayload, SendEmailResult } from '../providers/types';

import { EmailProcedure } from './email-procedure';

type InitEmailsOptions = {
  /**
   * One or more provider instances.
   *
   * - Single provider: used directly.
   * - Multiple providers: wrapped in a quota router that routes sends to
   *   whichever provider has remaining quota for the calendar month.
   */
  providers: EmailProvider[];
  /**
   * When true, emails are logged but NOT delivered.
   * Defaults to `process.env.NODE_ENV === 'development'`.
   */
  isDev?: boolean;
};

/**
 * The email client returned by `initEmails`.
 */
export type EmailClient = {
  /**
   * Low-level send — for one-off sends where a typed procedure is overkill.
   *
   * @returns `{ data, error }` — never throws.
   */
  send(payload: SendEmailPayload): Promise<SendEmailResult>;

  /**
   * Procedure builder — tRPC-inspired, chainable definition for typed emails.
   *
   * ```ts
   * export const magicLink = emails.email
   *   .input(z.object({ url: z.string().url() }))
   *   .from('App <no-reply@app.com>')
   *   .subject('Your magic link')
   *   .text(({ url }) => `Sign in: ${url}`);
   *
   * await magicLink.send({ to: user.email, input: { url } });
   * ```
   */
  email: EmailProcedure<never>;
};

/**
 * Initialise the email client.
 *
 * Inspired by `initTRPC.create()`: call once at app startup, export the client,
 * then compose reusable email definitions on top of it.
 *
 * ```ts
 * // emails.ts
 * export const emails = initEmails({
 *   providers: [
 *     resendProvider({ apiKey: env.RESEND_API_KEY, quotaPerMonth: 3_000 }),
 *     unosendProvider({ apiKey: env.UNOSEND_API_KEY, quotaPerMonth: 6_000 }),
 *   ],
 * });
 *
 * // magic-link.ts
 * export const magicLink = emails.email
 *   .input(z.object({ url: z.string().url() }))
 *   .from('App <no-reply@app.com>')
 *   .subject('Your magic link')
 *   .text(({ url }) => `Sign in: ${url}`);
 * ```
 */
export function initEmails(options: InitEmailsOptions): EmailClient {
  if (options.providers.length === 0) {
    throw new Error('[arki/emails] initEmails requires at least one provider');
  }

  const isDev = options.isDev ?? process.env['NODE_ENV'] === 'development';

  const provider: EmailProvider =
    options.providers.length === 1
      ? options.providers[0]!
      : quotaRouter(options.providers);

  const devProvider: EmailProvider = {
    name: 'dev',
    async send(payload) {
      debugEmails('[dev] Skipping delivery — to=%s subject="%s"', payload.to, payload.subject);
      return { data: { id: `dev-${Date.now()}` }, error: null };
    },
  };

  const activeProvider = isDev ? devProvider : provider;

  return {
    send(payload: SendEmailPayload): Promise<SendEmailResult> {
      return activeProvider.send(payload);
    },

    email: new EmailProcedure(activeProvider),
  };
}
