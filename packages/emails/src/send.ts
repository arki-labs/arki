/**
 * @deprecated Use `initEmails` from `@arki/emails` instead.
 *
 * This low-level helper is kept for backward compatibility.
 * Internally it delegates to `initEmails` with the no-op dev provider.
 */
import type { SendEmailPayload } from './providers/types';
import { initEmails } from './client/init';
import { resendProvider } from './providers/resend';

export type { SendEmailPayload };

/**
 * @deprecated Use `initEmails({ providers: [resendProvider({ apiKey })], isDev }).send(payload)`.
 *
 * Sends an email via Resend. Pass `isDev: true` to skip delivery
 * (same as `initEmails({ isDev: true })`).
 */
export const send = async (apiKey: string, payload: SendEmailPayload, options: { isDev: boolean }): Promise<void> => {
  const client = initEmails({ providers: [resendProvider({ apiKey })], isDev: options.isDev });
  const { error } = await client.send(payload);

  if (error) {
    throw new Error(`Email can't be sent: ${error.message}`);
  }
};
