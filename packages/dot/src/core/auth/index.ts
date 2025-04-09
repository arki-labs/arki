import NextAuth from 'next-auth';

import { authConfig } from './config';

export type { Session } from 'next-auth';

const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export { auth, handlers, signIn, signOut };

export { invalidateSessionToken, isSecureContext, validateSessionToken } from './config';
