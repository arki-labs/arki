/* @see https://github.com/nextauthjs/next-auth/pull/8932 */
import type { DefaultSession } from '@auth/core/types';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import NextAuth from 'next-auth';

import { getDb, getTableCreator } from '@arki/db';

import { env } from './env.mjs';
import ResendProvider from './resendAuthProvider';

export type { Session } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

const cache = new Map<string, ReturnType<typeof NextAuth>>();

export const init = (dbName: string) => {
  if (!cache.has(dbName)) {
    const nAuth = NextAuth({
      adapter: DrizzleAdapter(getDb(dbName), getTableCreator(dbName)),
      providers: [
        ResendProvider({
          from: env.EMAIL_FROM,
        }) as any,
      ],
      callbacks: {
        session: ({ session, user }) => ({
          ...session,
          user: {
            ...session.user,
            id: user.id,
          },
        }),
      },
    });

    cache.set(dbName, nAuth);
  }

  const nAuth = cache.get(dbName)!;

  return {
    GET: nAuth.handlers.GET,
    POST: nAuth.handlers.POST,
    auth: nAuth.auth,
    signIn: nAuth.signIn,
    signOut: nAuth.signOut,
  };
};
