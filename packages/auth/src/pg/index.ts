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
export * from '../runtime.js';
export { accountIdColumns, authIdSources, sessionIdColumns, userIdColumns, verificationIdColumns } from './ids.js';
