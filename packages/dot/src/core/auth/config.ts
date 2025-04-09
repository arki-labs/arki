import type { NextAuthConfig, Session as NextAuthSession } from 'next-auth';
import { skipCSRFCheck } from '@auth/core';
import { DrizzleAdapter } from '@auth/drizzle-adapter';

import { ResendProvider } from '@arki/auth';
import { NotionMagicLinkEmail } from '@arki/emails/templates/notion-magic-link';

import { db } from '../../db';
import { env } from '../../env';
import { Account, Authenticator, Session, User, VerificationToken } from '../../schema';

const adapter = DrizzleAdapter(db, {
  usersTable: User,
  accountsTable: Account,
  sessionsTable: Session,
  verificationTokensTable: VerificationToken,
  authenticatorsTable: Authenticator,
});

export const isSecureContext = env.NODE_ENV !== 'development';

export const authConfig = {
  adapter,
  // In development, we need to skip checks to allow Expo to work
  ...(isSecureContext
    ? ({} as unknown as any)
    : {
        skipCSRFCheck,
        trustHost: true,
      }),
  secret: env.AUTH_SECRET,
  providers: [
    ResendProvider(
      env.RESEND_API_KEY,
      {
        from: env.EMAIL_FROM,
      },
      ({ loginUrl }: { loginUrl: string }) =>
        NotionMagicLinkEmail({
          loginUrl,
          appKey: 'HolySpace',
          appUrl: 'https://holy.space',
          appDescription: 'HolySpace',
        }),
    ),
  ],
  callbacks: {
    session: opts => {
      if (!('user' in opts)) throw new Error('unreachable with session strategy');

      return {
        ...opts.session,
        user: {
          ...opts.session.user,
          id: opts.user.id,
        },
      };
    },
    async signIn(_params) {
      return true;
    },
    async redirect({ baseUrl }) {
      return baseUrl;
    },
    async jwt({ token }) {
      return token;
    },
  },
  events: {
    async signIn(_message) {
      /* on successful sign in */
    },
    async signOut(_message) {
      /* on signout */
    },
    async createUser(_message) {
      /* user created */
    },
    async updateUser(_message) {
      /* user updated - e.g. their email was verified */
    },
    async linkAccount(_message) {
      /* account (e.g. Twitter) linked to a user */
    },
    async session(_message) {
      /* session is active */
    },
  },
  debug: env.AUTH_DEBUG,
  pages: {
    signIn: '/sign-in',
    signOut: '/sign-out',
    error: '/auth-error', // Error code passed in query string as ?error=
    verifyRequest: '/verify-request', // (used for check email message)
    newUser: '/', // New users will be directed here on first sign in (leave the property out if not of interest)
  },
} satisfies NextAuthConfig;

export const validateSessionToken = async (token: string): Promise<NextAuthSession | null> => {
  const sessionToken = token.slice('Bearer '.length);
  const session = await adapter.getSessionAndUser?.(sessionToken);
  return session
    ? {
        user: {
          ...session.user,
        },
        expires: session.session.expires.toISOString(),
      }
    : null;
};

export const invalidateSessionToken = async (token: string) => {
  const sessionToken = token.slice('Bearer '.length);
  await adapter.deleteSession?.(sessionToken);
};
