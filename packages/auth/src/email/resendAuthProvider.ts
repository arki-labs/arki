import { createEmailClient } from '@arki/emails';

import type { EmailProviderConfig, EmailProviderUserConfig } from './sendVerificationRequest';
import { debugAuth } from '../debug';
import { env } from '../env';
import { sendVerificationRequest } from './sendVerificationRequest';

export function ResendProvider(
  apiKey: string,
  config: EmailProviderUserConfig,
  sendVerificationRequestTemplate?: (conf: { loginUrl: string }) => React.ReactElement | React.ReactNode,
): EmailProviderConfig & { from: string } {
  debugAuth.debug(
    '[ResendProvider] Initializing Resend email provider (hasApiKey: {hasApiKey}, hasTemplate: {hasTemplate})',
    { hasApiKey: !!apiKey, hasTemplate: !!sendVerificationRequestTemplate },
  );

  const emailClient = createEmailClient({ isDev: env.NODE_ENV === 'development', resend: { apiKey } });

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
