import type { DefaultSession } from 'next-auth';

export { ResendProvider } from './email/resendAuthProvider';

export type { Session } from 'next-auth';

declare module 'next-auth' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Session {
    user: {
      id: string;
    } & DefaultSession['user'];
    expires: string;
  }
}
