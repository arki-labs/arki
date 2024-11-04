import type { EmailConfig } from '@auth/core/providers/email';
import type { Theme } from '@auth/core/types';
import type { Resend } from 'resend';
import { createId } from '@paralleldrive/cuid2';

type SendVerificationRequestParams = {
  identifier: string;
  url: string;
  expires: Date;
  provider: EmailConfig & { from: string };
  token: string;
  theme: Theme;
  request: Request;
};

export const sendVerificationRequest =
  (resend: Resend, template: ({ loginUrl }: { loginUrl: string }) => React.ReactElement | React.ReactNode) =>
  async (params: SendVerificationRequestParams) => {
    const { identifier, url, provider } = params;
    const { host } = new URL(url);

    const isDevOrStaging = process.env.NODE_ENV === 'development' || process.env['VERCEL_ENV'] === 'preview';
    const to = isDevOrStaging ? 'delivered@resend.dev' : identifier;

    try {
      await resend.emails.send({
        to,
        from: provider.from,
        subject: `Sign in to ${host}`,
        react: template({ loginUrl: url }),
        text: text({ url, host }),
        headers: {
          'X-Entity-Ref-ID': createId(),
        },
      });
    } catch {
      throw new Error(`Verification request email to ${identifier} can't be sent`);
    }
  };

/** Email Text body (fallback for email clients that don't render HTML, e.g. feature phones) */
function text({ url, host }: { url: string; host: string }) {
  return `Sign in to ${host}\n${url}\n\n`;
}
