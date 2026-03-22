/**
 * @deprecated Use `initEmails` from `@arki/emails` instead.
 *
 * This low-level helper is kept for backward compatibility.
 * Internally it delegates to `initEmails` with the no-op dev provider.
 */
import { initEmails } from './client/init';
import { resendProvider } from './providers/resend';
import type { SendEmailPayload } from './providers/types';

export type { SendEmailPayload };

/**
 * @deprecated Use `initEmails({ providers: [resendProvider({ apiKey })] }).send(payload)`.
 *
 * Sends an email via Resend. In development (`NODE_ENV=development`) delivery
 * is skipped entirely — same behaviour as `initEmails({ isDev: true })`.
 */
export const send = async (apiKey: string, payload: SendEmailPayload): Promise<void> => {
  const isDev = process.env['NODE_ENV'] === 'development';

  const client = initEmails({ providers: [resendProvider({ apiKey })], isDev });
  const { error } = await client.send(payload);

  if (error) {
    throw new Error(`Email can't be sent: ${error.message}`);
  }
};
