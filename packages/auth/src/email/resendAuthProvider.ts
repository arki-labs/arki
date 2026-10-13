import type { EmailConfig, EmailUserConfig } from '@auth/core/providers/email';

import { createEmailClientFromEnv } from '@arki/emails';

import { debugAuth } from '../debug';
import { sendVerificationRequest } from './sendVerificationRequest';

export function ResendProvider(
  apiKey: string,
  config: EmailUserConfig,
  sendVerificationRequestTemplate?: (conf: { loginUrl: string }) => React.ReactElement | React.ReactNode,
): EmailConfig & { from: string } {
  debugAuth.debug(
    '[ResendProvider] Initializing Resend email provider (hasApiKey: {hasApiKey}, hasTemplate: {hasTemplate})',
    { hasApiKey: !!apiKey, hasTemplate: !!sendVerificationRequestTemplate },
  );

  const emailClient = createEmailClientFromEnv({ resendApiKey: apiKey });

  const provider = {
    id: 'email',
    type: 'email' as const,
    name: 'Email',
    server: '',
    from: 'Auth.js <no-reply@authjs.dev>',
    maxAge: 24 * 60 * 60,
    sendVerificationRequest: sendVerificationRequest(emailClient, sendVerificationRequestTemplate),
    options: config,
  };

  debugAuth.debug('[ResendProvider] Resend provider initialized (from: {from}, maxAge: {maxAge}s)', {
    from: provider.from,
    maxAge: provider.maxAge,
  });

  return provider;
}
