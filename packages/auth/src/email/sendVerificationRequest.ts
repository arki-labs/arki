import type { EmailConfig } from '@auth/core/providers/email';
import type { Theme } from '@auth/core/types';
import { createId } from '@paralleldrive/cuid2';
import type { Resend } from 'resend';

import { debugEmail } from '../debug';
import { env } from '../env';

type SendVerificationRequestParams = {
  identifier: string;
  url: string;
  expires: Date;
  provider: EmailConfig & { from?: string };
  token: string;
  theme: Theme;
  request: Request;
};

export const sendVerificationRequest = (
  resend: Resend,
  template?: ({ loginUrl }: { loginUrl: string }) => React.ReactElement | React.ReactNode,
) => {
  debugEmail('[sendVerificationRequest] Creating verification email sender (hasTemplate: %s)', !!template);

  return async (params: SendVerificationRequestParams) => {
    const { identifier, url, provider } = params;

    debugEmail('[sendVerificationRequest] Sending verification email (to: %s, hasFrom: %s)',
      identifier, !!provider.from);

    if (!provider.from) {
      debugEmail('[sendVerificationRequest] Error: from address is required');
      throw new Error('from is required');
    }

    const { host } = new URL(url);

    const isDevOrStaging = env.NODE_ENV === 'development';
    const to = isDevOrStaging ? 'delivered@resend.dev' : identifier;

    debugEmail('[sendVerificationRequest] Email configuration (host: %s, isDev: %s, recipient: %s)',
      host, isDevOrStaging, to);

    try {
      await resend.emails.send({
        to,
        from: provider.from,
        subject: `Sign in to ${host}`,
        react: template?.({ loginUrl: url }),
        text: text({ url, host }),
        headers: {
          'X-Entity-Ref-ID': createId(),
        },
      });
      debugEmail('[sendVerificationRequest] Verification email sent successfully to %s', to);
    } catch (error) {
      debugEmail('[sendVerificationRequest] Error sending verification email: %s',
        error instanceof Error ? error.message : 'Unknown error');
      throw new Error(`Verification request email to ${identifier} can't be sent`);
    }
  };
};

/** Email Text body (fallback for email clients that don't render HTML, e.g. feature phones) */
function text({ url, host }: { url: string; host: string }) {
  return `Sign in to ${host}\n${url}\n\n`;
}
