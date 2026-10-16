/**
 * `@arki/auth/pg` — the runtime: one factory that turns a definition and its bindings into a
 * working auth on Postgres (node-postgres or PGlite). Node and Bun.
 *
 * @example
 * export const auth = createAuth(authDefinition, {
 *   db,
 *   tables: authTables,
 *   mail,
 *   rateLimit: { store: kv },
 *   runtime: () => ({ url: env.URL, secret: env.AUTH_SECRET, production: env.NODE_ENV === 'production' }),
 * });
 * const principal = await auth.principal(request.headers);
 */
import type { AuthDefinition } from '../definition.js';
import type { Auth } from './build.js';
import type { AuthBindings, AuthTables } from './types.js';
import { buildAuth } from './build.js';

export type { Auth } from './build.js';
export type { AuthEngine } from './engine.js';
export type {
  AuthBindings,
  AuthDb,
  AuthEvents,
  AuthLinkTemplate,
  AuthRuntime,
  AuthSessions,
  AuthTables,
  AuthTemplates,
  AuthTestingApi,
  PrincipalFor,
  ProviderCredentials,
  ProviderCredentialsMap,
  RateLimitStore,
  SessionSummary,
  SignInFailure,
  TestSignInOptions,
  TestUserInput,
} from './types.js';
export { assertAuthSecret } from './secret.js';
export { additionalFieldsFromColumns } from './fields.js';
// The table factories still live in `../schema`; the delete step moves them here.
export {
  authAccountColumns,
  authSessionColumns,
  authUserColumns,
  authVerificationColumns,
  createAuthTables,
} from '../schema/index.js';
export type {
  AuthColumnFill,
  AuthColumnNaming,
  AuthColumnOptions,
  CreateAuthTablesOptions,
  ExtraColumns,
  PrimaryColumnSource,
} from '../schema/index.js';

/**
 * Builds the auth from its definition and the app's bindings. Every mistake a deployment can make
 * is refused here, at boot, with a coded `AuthError`.
 */
export function createAuth<D extends AuthDefinition, T extends AuthTables>(
  definition: D,
  bindings: AuthBindings<D, T>,
): Auth<D, T> {
  return buildAuth(definition, bindings);
}
