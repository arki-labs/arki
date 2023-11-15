/* @see https://github.com/nextauthjs/next-auth/pull/8932 */
import type { DefaultSession } from '@auth/core/types';
import NextAuth from 'next-auth';
import { JWT } from 'next-auth/jwt';

export { ResendProvider } from './email/resendAuthProvider';

export type { Session } from 'next-auth';

type UserId = string;

declare module 'next-auth/jwt' {
  interface JWT {
    id: UserId;
  }
}

declare module 'next-auth' {
  interface Session {
    user: {
      id: UserId;
    } & DefaultSession['user'];
  }
}
