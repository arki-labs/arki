
import  { type EmailConfig, type EmailUserConfig } from '@auth/core/providers/email';
import { Resend } from 'resend';

import { sendVerificationRequest } from './sendVerificationRequest';

export function ResendProvider(
  apiKey: string,
  config: EmailUserConfig,
  sendVerificationRequestTemplate: (conf: { loginUrl: string }) => React.ReactElement | React.ReactNode,
): EmailConfig & {from : string} {
  const resend = new Resend(apiKey);

  return {
    id: 'email',
    type: 'email',
    name: 'Email',
    server: '',
    from: 'Auth.js <no-reply@authjs.dev>',
    maxAge: 24 * 60 * 60,
    // TODO: fix type
    sendVerificationRequest: sendVerificationRequest(resend, sendVerificationRequestTemplate) as any,
    options: config,
  };
}
