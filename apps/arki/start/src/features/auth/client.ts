import { createAuthHooks } from '@daveyplate/better-auth-tanstack';

import { createAuthClient } from '@arki/auth/react';
import { authDefinition } from '@arki/backend/auth-definition';

import { getBaseUrl } from '~/config';

/**
 * Built from the same definition as the backend: it carries the client plugins the enabled
 * methods need, and `authClient.capabilities` tells the auth UI which methods to offer.
 */
export const authClient = createAuthClient(authDefinition, { baseURL: getBaseUrl() });

// SSR-safe session hook backed by TanStack Query.
// Do NOT use authClient.useSession() directly — it uses nanostores
// which breaks during SSR (useRef null dispatcher).
const authHooks = createAuthHooks(authClient);
export const useSession = authHooks.useSession;
