import { getRequest } from '@tanstack/react-start/server';

import { auth } from '@arki/backend/auth';

export type { Session, User } from 'better-auth/types';

/**
 * Get the current session in a server context (loaders, actions, API routes).
 */
export const getSession = async () => {
  const request = getRequest();

  return await auth.api.getSession({
    headers: request.headers,
  });
};

export { auth };
