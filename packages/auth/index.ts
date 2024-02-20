/* @see https://github.com/nextauthjs/next-auth/pull/8932 */
import { type DefaultSession } from '@auth/core/types';

export { ResendProvider } from './email/resendAuthProvider';

export type { Session } from 'next-auth';

type UserId = string;

declare module 'next-auth' {
  interface Session {
    user: {
      id: UserId;
    } & DefaultSession['user'];
  }
}
