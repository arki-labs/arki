/**
 * @deprecated Use `initEmails` from `@arki/emails` instead.
 *
 * This low-level helper is kept for backward compatibility.
 * Internally it delegates to the Resend provider.
 */
import { resendProvider } from './providers/resend';
import type { SendEmailPayload } from './providers/types';

export type { SendEmailPayload };

/**
 * @deprecated Use `initEmails({ providers: [resendProvider({ apiKey })] }).send(payload)`.
 *
 * Sends an email via Resend. `isDev` redirects all mail to `delivered@resend.dev`.
 */
export const send = async (apiKey: string, payload: SendEmailPayload): Promise<void> => {
  const isDevOrStaging =
    process.env['NODE_ENV'] === 'development' || process.env['VERCEL_ENV'] === 'preview';

  const to = isDevOrStaging ? 'delivered@resend.dev' : payload.to;

  const provider = resendProvider({ apiKey });
  const { error } = await provider.send({ ...payload, to });

  if (error) {
    throw new Error(`Email can't be sent: ${error.message}`);
  }
};
