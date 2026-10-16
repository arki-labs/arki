import { logTransport } from '@arki/mail';
import { resend } from '@arki/mail/http/resend';

import { env } from '../../env';
import { APP_NAME } from '../../info';
import { kv } from '../../kv';
import { initAuth } from './config';

/**
 * The mail transport, read at boot. Development logs mail; a deployment without a Resend key
 * fails loud here instead of booting an auth whose links never arrive.
 */
function authMailTransport() {
  if (env.NODE_ENV === 'development') return logTransport();
  if (env.RESEND_API_KEY) return resend({ apiKey: env.RESEND_API_KEY });
  if (env.NODE_ENV === 'production') {
    throw new Error('[arki] RESEND_API_KEY is required in production: auth mails sign-in links.');
  }
  return logTransport();
}

export const auth = initAuth({
  runtime: () => ({
    url: env.VITE_URL,
    productionUrl: env.PRODUCTION_URL || env.VITE_URL,
    secret: env.AUTH_SECRET,
    production: env.NODE_ENV === 'production',
  }),
  // The sender the old magic-link mail used (the reset and verify mails named other senders).
  mail: { transport: authMailTransport(), from: `${APP_NAME} <no-reply@furculita.net>` },
  // Off outside production: dev runs without a shared limiter budget.
  rateLimit: env.NODE_ENV === 'production' ? kv : false,
});
