import { env } from '../../env';
import { APP_KEY, APP_NAME } from '../../info';
import { initAuth } from './config';

export const auth = initAuth({
  appName: APP_NAME,
  appKey: APP_KEY,
  baseUrl: env.VITE_URL,
  productionUrl: env.PRODUCTION_URL || env.VITE_URL,
  secret: env.AUTH_SECRET,

  googleClientId: env.GOOGLE_CLIENT_ID,
  googleClientSecret: env.GOOGLE_CLIENT_SECRET,

  appleClientId: env.APPLE_CLIENT_ID,
  appleClientSecret: env.APPLE_CLIENT_SECRET,
  appleAppBundleIdentifier: env.APPLE_APP_BUNDLE_IDENTIFIER,

  facebookClientId: env.FACEBOOK_CLIENT_ID,
  facebookClientSecret: env.FACEBOOK_CLIENT_SECRET,

  resendApiKey: env.RESEND_API_KEY,
});
