import { expo } from '@better-auth/expo';
import { betterAuth } from '@arki/auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink, oAuthProxy } from 'better-auth/plugins';
import { Resend } from 'resend';

import { createPrefixedId } from '@arki/db/id';

import { db } from '../../db';

export function initAuth(options: {
  appName: string;
  appKey?: string;
  baseUrl: string;
  productionUrl: string;
  secret: string | undefined;

  googleClientId?: string;
  googleClientSecret?: string;

  appleClientId?: string;
  appleClientSecret?: string;
  appleAppBundleIdentifier?: string;

  facebookClientId?: string;
  facebookClientSecret?: string;

  resendApiKey?: string;
}) {
  const resend = new Resend(options.resendApiKey);

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
      }),
      expo(),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          const resp = await resend.emails.send({
            to: email,
            from: 'Domodoro <no-reply@furculita.net>',
            subject: 'Your magic link',
            text: `Click the link to sign in: ${url}`,
          });

          if (resp.error) {
            console.error('Failed to send magic link email:', resp.error);
            throw new Error('Failed to send magic link email. Please try again later.');
          }
        },
      }),
    ],
    user: {
      changeEmail: {
        enabled: true,
        sendChangeEmailVerification: async ({
          user,
          newEmail,
          url,
          token,
        }: {
          user: { email: string };
          newEmail: string;
          url: string;
          token: string;
        }) => {
          await resend.emails.send({
            to: user.email, // verification email must be sent to the current user email to approve the change
            from: 'Arki <no-reply@arki.com>',
            subject: 'Approve email change',
            text: `Click the link to approve the change: ${url}?token=${token}&newEmail=${newEmail}`,
          });
        },
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'apple', 'facebook'],
        allowDifferentEmails: true,
        updateUserInfoOnLink: true,
        allowUnlinkingAll: true,
      },
    },
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user, url, token: _token }) => {
        await resend.emails.send({
          to: user.email,
          from: 'Domodoro <no-reply@domodoro.com>',
          subject: 'Reset your password',
          text: `Click the link to reset your password: ${url}`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url, token: _token }) => {
        await resend.emails.send({
          to: user.email,
          from: 'Domodoro <no-reply@domodoro.com>',
          subject: 'Verify your email address',
          text: `Click the link to verify your email: ${url}`,
        });
      },
    },
    socialProviders: {
      google: googleProvider,
      facebook: facebookProvider,
      apple: appleProvider,
    },
    trustedOrigins: ['expo://', 'https://appleid.apple.com'],
  });
}

export type Auth = ReturnType<typeof initAuth>;
export type Session = Auth['$Infer']['Session'];
