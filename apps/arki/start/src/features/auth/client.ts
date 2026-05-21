import { createAuthHooks } from '@daveyplate/better-auth-tanstack';
import { magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { getBaseUrl } from '~/config';

export const authClient = createAuthClient({
  baseURL: getBaseUrl(),
  plugins: [magicLinkClient()],
});

// SSR-safe session hook backed by TanStack Query.
// Do NOT use authClient.useSession() directly — it uses nanostores
// which breaks during SSR (useRef null dispatcher).
const authHooks = createAuthHooks(authClient);
export const useSession = authHooks.useSession;
