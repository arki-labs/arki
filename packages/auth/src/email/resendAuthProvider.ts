import type { EmailConfig, EmailUserConfig } from '@auth/core/providers/email';
import { Resend } from 'resend';

import { debugAuth } from '../debug';
import { sendVerificationRequest } from './sendVerificationRequest';

export function ResendProvider(
  apiKey: string,
  config: EmailUserConfig,
  sendVerificationRequestTemplate?: (conf: { loginUrl: string }) => React.ReactElement | React.ReactNode,
): EmailConfig & { from: string } {
  debugAuth('[ResendProvider] Initializing Resend email provider (hasApiKey: %s, hasTemplate: %s)',
    !!apiKey, !!sendVerificationRequestTemplate);

  const resend = new Resend(apiKey);

  const provider = {
    id: 'email',
    type: 'email',
    name: 'Email',
    server: '',
    from: 'Auth.js <no-reply@authjs.dev>',
    maxAge: 24 * 60 * 60,
    sendVerificationRequest: sendVerificationRequest(resend, sendVerificationRequestTemplate),
    options: config,
  };

  debugAuth('[ResendProvider] Resend provider initialized (from: %s, maxAge: %ds)',
    provider.from, provider.maxAge);

  return provider;
}
