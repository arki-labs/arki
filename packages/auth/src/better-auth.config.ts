import type { BetterAuthPlugin } from 'better-auth';
import type { DB } from 'better-auth/adapters/drizzle';
import { expo } from '@better-auth/expo';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink, oAuthProxy } from 'better-auth/plugins';

import { createPrefixedId } from '@arki/db/id';
import { getLogger } from '@arki/log';
import { logTransport, mailer } from '@arki/mail';
import { resend } from '@arki/mail/http/resend';
import { magicLink as magicLinkMail } from '@arki/mail/templates/auth';

import { betterAuth } from './create-auth';
import { env } from './env';

const authLogger = getLogger('arki:auth');

export function initAuth(
  db: DB,
  userOptions: {
    appName: string;
    appKey?: string;
    baseUrl: string;
    productionUrl?: string;
    secret?: string;

    googleClientId?: string;
    googleClientSecret?: string;

    appleClientId?: string;
    appleClientSecret?: string;
    appleAppBundleIdentifier?: string;

    facebookClientId?: string;
    facebookClientSecret?: string;

    resendApiKey?: string;
  },
) {
  // Return type intentionally inferred — explicit `ReturnType<typeof betterAuth>`
  // widens to `Auth<BetterAuthOptions>` and clashes with the narrower inferred
  // type post-better-auth API drift. Inference preserves the precise plugin shape.
  const options = {
    productionUrl: env.PRODUCTION_URL || userOptions.baseUrl,
    secret: env.AUTH_SECRET,

    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,

    appleClientId: env.APPLE_CLIENT_ID,
    appleClientSecret: env.APPLE_CLIENT_SECRET,
    appleAppBundleIdentifier: env.APPLE_APP_BUNDLE_IDENTIFIER,

    facebookClientId: env.FACEBOOK_CLIENT_ID,
    facebookClientSecret: env.FACEBOOK_CLIENT_SECRET,

    resendApiKey: env.RESEND_API_KEY,
    ...userOptions,
  };

  if (!options.secret) {
    throw new Error('AUTH_SECRET is not set');
  }

  const mail = options.resendApiKey
    ? mailer({
        transport: env.NODE_ENV === 'development' ? logTransport() : resend({ apiKey: options.resendApiKey }),
        from: 'Brandability <no-reply@furculita.net>',
      })
    : undefined;

  const googleProvider =
    options.googleClientId && options.googleClientSecret
      ? {
          clientId: options.googleClientId,
          clientSecret: options.googleClientSecret,
        }
      : undefined;

  const facebookProvider =
    options.facebookClientId && options.facebookClientSecret
      ? {
          clientId: options.facebookClientId,
          clientSecret: options.facebookClientSecret,
        }
      : undefined;

  const appleProvider =
    options.appleClientId && options.appleClientSecret && options.appleAppBundleIdentifier
      ? {
          clientId: options.appleClientId,
          clientSecret: options.appleClientSecret,
          appBundleIdentifier: options.appleAppBundleIdentifier,
        }
      : undefined;

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      usePlural: true,
    }),
    appName: options.appName,
    baseURL: options.baseUrl,
    secret: options.secret,

    advanced: {
      cookiePrefix: options.appKey ? `auth-${options.appKey}` : 'auth',
      database: {
        generateId: ({ model }) => {
          if (model === 'users') {
            return createPrefixedId(`u_`);
          }
          if (model === 'sessions') {
            return createPrefixedId(`sess_`);
          }
          if (model === 'accounts') {
            return createPrefixedId(`acc_`);
          }
          if (model === 'verifications') {
            return createPrefixedId(`verif_`);
          }

          return createPrefixedId(`${model}_`);
        },
      },
    },
    plugins: [
      oAuthProxy({
        /**
         * Auto-inference blocked by https://github.com/better-auth/better-auth/pull/2891
         */
        currentURL: options.baseUrl,
        productionURL: options.productionUrl,
      }) as BetterAuthPlugin,
      expo(),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          if (!mail) {
            authLogger.error('Email client not configured, cannot send magic link');
            throw new Error('Email service not configured. Please try again later.');
          }

          // better-auth's magic link lives 5 minutes (the plugin's default `expiresIn`).
          const { error } = await mail.send(
            magicLinkMail,
            { appName: options.appName, url, expiresInMinutes: 5 },
            { to: email },
          );

          if (error) {
            authLogger.error('Failed to send magic link email: {message}', { message: error.message });
            throw new Error('Failed to send magic link email. Please try again later.');
          }
        },
      }),
    ],
    user: {
      additionalFields: {
        // Add any additional user fields here if needed
      },
    },
    socialProviders: {
      ...(googleProvider && { google: googleProvider }),
      ...(facebookProvider && { facebook: facebookProvider }),
      ...(appleProvider && { apple: appleProvider }),
    },
  });
}

export type Auth = ReturnType<typeof initAuth>;
