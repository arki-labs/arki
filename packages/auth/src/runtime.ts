/**
 * The runtime both database entries share: `@arki/auth/pg` and `@arki/auth/sqlite` re-export it
 * next to their own id columns. The engine reads the dialect from the `db` binding.
 */
import type { AuthDefinition } from './definition.js';
import type { Auth } from './pg/build.js';
import type { AuthBindings, AuthTables, SessionValues } from './pg/types.js';
import { buildAuth } from './pg/build.js';

export type { Auth } from './pg/build.js';
export type { AuthEngine } from './pg/engine.js';
export type {
  AuthBindingEvents,
  AuthBindings,
  AuthDb,
  AuthTable,
  AuthEvents,
  AuthMailBrand,
  AuthMailBrandPicker,
  AuthLinkInputSchema,
  AuthLinkMailData,
  AuthLinkMailInput,
  AuthLinkTemplate,
  AuthRuntime,
  AuthSessions,
  AuthTables,
  AuthTemplates,
  AuthTestingApi,
  IdTokenSession,
  IdTokenSignIn,
  PrincipalFor,
  ProviderCredentials,
  ProviderCredentialsMap,
  OnlySessionColumns,
  RateLimitBinding,
  RateLimitStore,
  SessionEvents,
  SessionSummary,
  SessionValues,
  SignInFailure,
  TestSignInOptions,
  TestUserInput,
} from './pg/types.js';
export { assertAuthSecret } from './pg/secret.js';
export { additionalFieldsFromColumns } from './pg/fields.js';
export { authLinkInput } from './pg/mail.js';
export {
  authAccountColumns,
  authSessionColumns,
  authUserColumns,
  authVerificationColumns,
  createAuthTables,
} from './schema/auth-tables.js';
export type {
  AuthColumnFill,
  AuthColumnNaming,
  AuthColumnOptions,
  CreateAuthTablesOptions,
  ExtraColumns,
  PrimaryColumnSource,
  UserIdSource,
} from './schema/auth-tables.js';

/**
 * Builds the auth from its definition and the app's bindings. Every mistake a deployment can make
 * is refused here, at boot, with a coded `AuthError`. `S` is what `on.sessionCreating` returns,
 * inferred and checked against the session table.
 */
export function createAuth<
  D extends AuthDefinition,
  T extends AuthTables,
  S extends SessionValues<T> = SessionValues<T>,
>(definition: D, bindings: AuthBindings<D, T, S>): Auth<D, T> {
  return buildAuth(definition, bindings);
}
