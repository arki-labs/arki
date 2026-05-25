import { Resend } from 'resend';

import { createPrefixedIdHook, defineAuthBackend } from '@arki/auth';

import { db } from '../../db';
import { Account, Session, User, verifications } from '../../features/auth/schema';

type Options = {
  appName: string;
  appKey: string;
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
};

export function initAuth(options: Options) {
  const resend = new Resend(options.resendApiKey);

  return defineAuthBackend({
    db,
    schema: { user: User, account: Account, session: Session, verification: verifications },
    appName: options.appName,
    appKey: options.appKey,
    baseUrl: options.baseUrl,
    productionUrl: options.productionUrl,
    secret: options.secret,
    generateId: createPrefixedIdHook(),
    trustedOrigins: ['expo://', 'https://appleid.apple.com'],

    magicLink: {
      send: async ({ email, url }) => {
        const resp = await resend.emails.send({
          to: email,
          from: 'Domodoro <no-reply@furculita.net>',
          subject: 'Your magic link',
          text: `Click the link to sign in: ${url}`,
        });
        if (resp.error) throw new Error('Failed to send magic link email. Please try again later.');
      },
    },

    user: {
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url, token }) => {
          await resend.emails.send({
            to: user.email,
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
      sendResetPassword: async ({ user, url }) => {
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
      sendVerificationEmail: async ({ user, url }) => {
        await resend.emails.send({
          to: user.email,
          from: 'Domodoro <no-reply@domodoro.com>',
          subject: 'Verify your email address',
          text: `Click the link to verify your email: ${url}`,
        });
      },
    },

    socialProviders: {
      ...(options.googleClientId && options.googleClientSecret
        ? { google: { clientId: options.googleClientId, clientSecret: options.googleClientSecret } }
        : {}),
      ...(options.appleClientId && options.appleClientSecret
        ? {
            apple: {
              clientId: options.appleClientId,
              clientSecret: options.appleClientSecret,
              appBundleIdentifier: options.appleAppBundleIdentifier,
            },
          }
        : {}),
      ...(options.facebookClientId && options.facebookClientSecret
        ? { facebook: { clientId: options.facebookClientId, clientSecret: options.facebookClientSecret } }
        : {}),
    },
  });
}

export type Auth = ReturnType<typeof initAuth>;
export type Session = Auth['$Infer']['Session'];
