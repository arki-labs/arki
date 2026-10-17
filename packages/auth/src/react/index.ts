/**
 * Auth UI: the auth client, the sign-in form (with its handler factory).
 * Page templates are in `@arki/auth/react/templates`.
 * Needs `react`, `@arki/ui`, `@arki/icons` and `@tanstack/react-router` (optional peers).
 */
export { SignInForm, createSignInHandlers } from './sign-in-form.js';
export type {
  SignInCapableAuthClient,
  SignInFormProps,
  SignInFormSource,
  SignInHandlerOptions,
  SignInHandlers,
  SignInLocalization,
} from './sign-in-form.js';
export { createAuthClient } from './client.js';
export type { AuthClient, AuthClientOptions } from './client.js';
export type { AuthCapabilities } from './capabilities.js';
export { resolveAuthClientBaseUrl } from '../client-base-url.js';
