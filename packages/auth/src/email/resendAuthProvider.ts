import type { ReactElement, ReactNode } from 'react';

import { logTransport, mailer } from '@arki/mail';
import { resend } from '@arki/mail/http/resend';

import type { EmailProviderConfig, EmailProviderUserConfig } from './sendVerificationRequest';
import { debugAuth } from '../debug';
import { env } from '../env';
import { sendVerificationRequest } from './sendVerificationRequest';

export function ResendProvider(
  apiKey: string,
  config: EmailProviderUserConfig,
  sendVerificationRequestTemplate?: (conf: { loginUrl: string }) => ReactElement | ReactNode,
): EmailProviderConfig & { from: string } {
  debugAuth.debug(
    '[ResendProvider] Initializing Resend email provider (hasApiKey: {hasApiKey}, hasTemplate: {hasTemplate})',
    { hasApiKey: !!apiKey, hasTemplate: !!sendVerificationRequestTemplate },
  );

  const from = 'Auth.js <no-reply@authjs.dev>';
  const mail = mailer({
    transport: env.NODE_ENV === 'development' ? logTransport() : resend({ apiKey }),
    from,
  });

  const provider = {
    id: 'email',
    type: 'email' as const,
    name: 'Email',
    server: '',
    from,
    maxAge: 24 * 60 * 60,
    sendVerificationRequest: sendVerificationRequest(mail, sendVerificationRequestTemplate),
    options: config,
  };

  debugAuth.debug('[ResendProvider] Resend provider initialized (from: {from}, maxAge: {maxAge}s)', {
    from: provider.from,
    maxAge: provider.maxAge,
  });

  return provider;
}
