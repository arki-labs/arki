import { createId } from '@paralleldrive/cuid2';

import type { EmailClient } from '@arki/emails';

import { debugEmail } from '../debug';
import { env } from '../env';

/** Extra provider options a caller passes through unchanged (the Auth.js email-provider `options` slot). */
export type EmailProviderUserConfig = Record<string, unknown>;

/** Visual theme an Auth.js-style email provider receives. Only kept for shape compatibility. */
export type EmailTheme = {
  colorScheme?: 'auto' | 'dark' | 'light';
  logo?: string;
  brandColor?: string;
  buttonText?: string;
};

type SendVerificationRequestParams = {
  identifier: string;
  url: string;
  expires: Date;
  provider: { from?: string };
  token: string;
  theme: EmailTheme;
  request: Request;
};

/** The email-provider object `ResendProvider` builds (the Auth.js email-provider shape, typed locally). */
export type EmailProviderConfig = {
  id: string;
  type: 'email';
  name: string;
  server: string;
  from?: string;
  maxAge: number;
  sendVerificationRequest: (params: SendVerificationRequestParams) => Promise<void>;
  options: EmailProviderUserConfig;
};

export const sendVerificationRequest = (
  emailClient: EmailClient,
  template?: ({ loginUrl }: { loginUrl: string }) => React.ReactElement | React.ReactNode,
) => {
  debugEmail.debug('[sendVerificationRequest] Creating verification email sender (hasTemplate: {hasTemplate})', {
    hasTemplate: !!template,
  });

  return async (params: SendVerificationRequestParams) => {
    const { identifier, url, provider } = params;

    debugEmail.debug('[sendVerificationRequest] Sending verification email (to: {to}, hasFrom: {hasFrom})', {
      to: identifier,
      hasFrom: !!provider.from,
    });

    if (!provider.from) {
      debugEmail.debug('[sendVerificationRequest] Error: from address is required');
      throw new Error('from is required');
    }

    const { host } = new URL(url);

    const isDevOrStaging = env.NODE_ENV === 'development';
    const to = isDevOrStaging ? 'delivered@resend.dev' : identifier;

    debugEmail.debug(
      '[sendVerificationRequest] Email configuration (host: {host}, isDev: {isDev}, recipient: {recipient})',
      { host, isDev: isDevOrStaging, recipient: to },
    );

    const { error } = await emailClient.send({
      to,
      from: provider.from,
      subject: `Sign in to ${host}`,
      text: text({ url, host }),
      headers: {
        'X-Entity-Ref-ID': createId(),
      },
    });

    if (error) {
      debugEmail.debug('[sendVerificationRequest] Error sending verification email: {email}', { email: error.message });
      throw new Error(`Verification request email to ${identifier} can't be sent`);
    }

    debugEmail.debug('[sendVerificationRequest] Verification email sent successfully to {to}', { to });
  };
};

/** Email Text body (fallback for email clients that don't render HTML, e.g. feature phones) */
function text({ url, host }: { url: string; host: string }) {
  return `Sign in to ${host}\n${url}\n\n`;
}
