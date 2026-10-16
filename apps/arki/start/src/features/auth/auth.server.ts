import { getRequest } from '@tanstack/react-start/server';

import { auth } from '@arki/backend/auth';

/**
 * Who is calling, in a server context (loaders, actions, API routes): the principal
 * (`user` with its branded id, `session`, `roles`), or `null` for a guest.
 */
export const getPrincipal = async () => {
  const request = getRequest();
  return auth.principal(request.headers);
};

export { auth };
