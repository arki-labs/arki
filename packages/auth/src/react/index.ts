/**
 * Auth UI: the auth client, the sign-in form (with its handler factory).
 * Page templates are in `@arki/auth/react/templates`.
 * Needs `react`, `@arki/ui`, `@arki/icons` and `@tanstack/react-router` (optional peers).
 */
export * from './sign-in-form';
export { createAuthClient } from './client';
export type { AuthClient, AuthClientOptions } from './client';
export type { AuthCapabilities } from './capabilities';
export { resolveAuthClientBaseUrl } from '../client-base-url';
