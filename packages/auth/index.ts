/* @see https://github.com/nextauthjs/next-auth/pull/8932 */
import type { DefaultSession } from '@auth/core/types';
import NextAuth from 'next-auth';

export { ResendProvider } from './email/resendAuthProvider';

export type { Session } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}
