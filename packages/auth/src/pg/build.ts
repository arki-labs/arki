/**
 * The auth builder behind `createAuth` and `testAuth`.
 */
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { makeSignature } from 'better-auth/crypto';
import { getTableColumns } from 'drizzle-orm';

import { dialectOf } from '@arki/db/dialect';
import { isFailure } from '@arki/failure';

import { is, recordSchema } from '@arki/schema';
import { z } from 'zod';
import type { AuthDefinition, AuthMethod, IdTokenMethodsOf, ResolvedDefinition, SocialMethod } from '../definition.js';
import type { AuthErrorCode } from '../errors.js';
import type { PrincipalVia, SessionIdOf, UserIdOf, UserRow } from '../principal.js';
import type { SocialProviders } from './assemble.js';
import type { AuthEngine } from './engine.js';
import type {
  AuthBindingEvents,
  AuthBindings,
  AuthRuntime,
  AuthSessions,
  AuthTable,
  AuthTables,
  AuthTestingApi,
  IdTokenSession,
  IdTokenSignIn,
  PrincipalFor,
  ProviderCredentialsMap,
  SessionValues,
  SignInFailure,
} from './types.js';
import { ID_TOKEN_METHODS, isIdTokenMethod, isSocialMethod, resolveDefinition } from '../definition.js';
import { AUTH_ERROR_CODES, AuthError, isAuthError } from '../errors.js';
import { log } from '../log.js';
import { isUserId, toPrincipal, toPrincipalSession, toUserRow } from '../principal.js';
import { engineOptions } from './assemble.js';
import {
  AUTH_BASE_PATH,
  createEmitter,
  enginePath,
  failureOf,
  idTokenMethodOf,
  methodOfSource,
  requestIdOf,
  runObserver,
  signInMethodOf,
} from './events.js';
import { additionalFieldsFromColumns } from './fields.js';
import { authMail } from './mail.js';
import { assertAuthSecret } from './secret.js';
import { kvRateLimitStorage } from './security/kv-storage.js';
import { createSessions } from './sessions.js';
import { observeAuth } from './telemetry.js';
import { ENGINE_SESSION_COLUMNS } from './types.js';

/** A working auth. Build it with {@link createAuth}. */
export type Auth<D extends AuthDefinition, T extends AuthTables> = {
  readonly definition: D;
  /** Serves the engine's routes under `/api/auth`. */
  readonly handler: (request: Request) => Promise<Response>;
  /** Who is calling, or `null` for a guest. A cookie and a bearer token together are `ARKI_AUTH_E401`. */
  readonly principal: (headers: Headers) => Promise<PrincipalFor<D, T> | null>;
  readonly sessions: AuthSessions<PrincipalFor<D, T>, SessionIdOf<T>, UserIdOf<T>>;
  /**
   * Whether the definition enables `provider` and the engine can verify its id tokens. Narrows
   * `provider` for `signInWithIdToken`, so app code can branch without naming a disabled method.
   */
  readonly supportsIdToken: (provider: SocialMethod) => provider is IdTokenMethodsOf<D>;
  /**
   * Native sign-in: verifies the provider's id token, signs the user in (creating them on first
   * use) and returns the bearer token with its principal. `null` when the sign-in is refused: a
   * token that fails verification (signature, audience, issuer, age, nonce), no email from the
   * provider, an unverified email, or an existing user while `account.linking` is off. Needs
   * `sessions: { bearer: true }` (`ARKI_AUTH_E001` otherwise). Rate limited like the sign-in routes:
   * `ARKI_AUTH_E429` over the limit, `ARKI_AUTH_E503` when the store fails.
   */
  readonly signInWithIdToken: (input: IdTokenSignIn<D>) => Promise<IdTokenSession<PrincipalFor<D, T>> | null>;
  /** The engine itself: for the E2E handler, tests and the escape hatch. Not for app code. */
  readonly engine: AuthEngine;
  /** Test-only helpers. Every call throws `ARKI_AUTH_E005` in production. */
  readonly testing: AuthTestingApi<UserRow<D, T>>;
};

const invalid = (message: string): never => {
  throw new AuthError(AUTH_ERROR_CODES.invalidConfig, `[@arki/auth] ${message}`);
};

const nonEmptyText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** Reads one provider's credentials from the runtime values; anything missing is `ARKI_AUTH_E001`. */
function credentialsOf<K extends SocialMethod>(providers: unknown, method: K) {
  const entry: unknown =
    is(providers, recordSchema) ? Reflect.get(providers, method) : undefined;
  const field = (key: string): unknown =>
    is(entry, recordSchema) ? Reflect.get(entry, key) : undefined;
  const clientId = field('clientId');
  const clientSecret = field('clientSecret');
  if (!nonEmptyText(clientId) || !nonEmptyText(clientSecret)) {
    return invalid(`\`${method}\` is enabled but \`runtime().providers.${method}\` lacks clientId or clientSecret.`);
  }
  const scope = field('scope');
  const scopes = Array.isArray(scope) ? scope.filter((value): value is string => nonEmptyText(value)) : undefined;
  return { clientId, clientSecret, ...(scopes !== undefined && { scope: scopes }), field };
}

/** The engine's social providers for the enabled methods, from checked runtime values. */
function socialProvidersFor(methods: readonly AuthMethod[], providers: unknown): SocialProviders {
  const result: SocialProviders = {};
  for (const method of methods.filter((method): method is SocialMethod => isSocialMethod(method))) {
    const { field, ...credentials } = credentialsOf(providers, method);
    const optional = (key: keyof ProviderCredentialsMap['apple'] | keyof ProviderCredentialsMap['microsoft']) => {
      const value = field(key);
      return nonEmptyText(value) ? { [key]: value } : {};
    };
    switch (method) {
      case 'google': {
        result.google = credentials;
        break;
      }
      case 'apple': {
        result.apple = { ...credentials, ...optional('appBundleIdentifier') };
        break;
      }
      case 'facebook': {
        result.facebook = credentials;
        break;
      }
      case 'microsoft': {
        result.microsoft = { ...credentials, ...optional('tenantId') };
        break;
      }
      default: {
        result.github = credentials;
      }
    }
  }
  return result;
}

function assertUrl(url: string, label: string): void {
  try {
    new URL(url);
  } catch {
    invalid(`${label} "${url}" is not an absolute URL.`);
  }
}

function assertWorkspaceTables(tables: AuthTables, teams: boolean): void {
  const sessionColumns = getTableColumns(tables.Session);
  const missing = [
    ...(Object.hasOwn(sessionColumns, 'activeOrganizationId') ? [] : ['Session.activeOrganizationId']),
    ...(teams && !Object.hasOwn(sessionColumns, 'activeTeamId') ? ['Session.activeTeamId'] : []),
    ...(tables.Organization === undefined ? ['Organization'] : []),
    ...(tables.Member === undefined ? ['Member'] : []),
    ...(tables.Invitation === undefined ? ['Invitation'] : []),
    ...(teams && tables.Team === undefined ? ['Team'] : []),
    ...(teams && tables.TeamMember === undefined ? ['TeamMember'] : []),
  ];
  if (missing.length > 0) {
    throw new AuthError(
      AUTH_ERROR_CODES.tableMissing,
      `[@arki/auth] \`workspaces\` is on but \`tables\` lacks ${missing.join(', ')}. Add \`createWorkspaceTables(...)\`.`,
    );
  }
}

/**
 * The engine's own id generation is off (`generateId: false`): every id comes from the table's
 * default. A table whose `id` has none would insert a null id at the first sign-up.
 */
function assertIdDefaults(tables: AuthTables, workspaces: ResolvedDefinition['workspaces']): void {
  const checked: readonly (readonly [string, AuthTable | undefined])[] = [
    ['User', tables.User],
    ['Session', tables.Session],
    ['Account', tables.Account],
    ['Verification', tables.Verification],
    ...(workspaces === undefined
      ? []
      : ([
          ['Organization', tables.Organization],
          ['Member', tables.Member],
          ['Invitation', tables.Invitation],
          ...(workspaces.teams
            ? ([
                ['Team', tables.Team],
                ['TeamMember', tables.TeamMember],
              ] as const)
            : []),
        ] as const)),
  ];
  const missing = checked.flatMap(([name, table]) => {
    if (table === undefined) return [];
    const columns = getTableColumns(table);
    const id = Object.hasOwn(columns, 'id') ? columns['id'] : undefined;
    return id !== undefined && (id.hasDefault || id.defaultFn !== undefined) ? [] : [name];
  });
  if (missing.length > 0) {
    invalid(
      `The \`id\` column of ${missing.join(', ')} has no default, and the engine makes no ids. ` +
        "Use `createAuthTables` (or `createWorkspaceTables`), or an id factory's `primaryColumn()`.",
    );
  }
}

/** A session refused by `sessionCreating`: 403 with the app's error code. */
const sessionRefused = (error: AuthError) => new APIError('FORBIDDEN', { code: error.code, message: error.message });

const bearerTokenOf = (headers: Headers): string | undefined => {
  const value = headers.get('authorization');
  return value !== null && /^bearer\s+\S/i.test(value) ? value.replace(/^bearer\s+/i, '') : undefined;
};

const hasCookie = (headers: Headers, name: string): boolean =>
  (headers.get('cookie') ?? '').split(';').some(part => part.trim().startsWith(`${name}=`));

/** The session cookie the engine set on a response, as a `cookie` header value. */
function sessionCookieOf(response: Response, name: string): string | undefined {
  for (const line of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = line.split(';');
    const separator = pair.indexOf('=');
    const value = pair.slice(separator + 1);
    const cleared = attributes.some(attribute => /^\s*max-age\s*=\s*0\s*$/i.test(attribute));
    if (pair.slice(0, separator).trim() === name && value !== '' && !cleared) return `${name}=${value}`;
  }
  return undefined;
}

/**
 * A copy of a small response with extra headers (engine responses may have immutable headers).
 * The body is copied as text: a `string` body types the same on every runtime's `lib`.
 */
async function withHeaders(response: Response, extra: Readonly<Record<string, string>>): Promise<Response> {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(await response.text(), { status: response.status, statusText: response.statusText, headers });
}

/** The engine routes an `account` switch opens. While the switch is off they answer 404. */
function closedAccountPaths(account: ResolvedDefinition['account']): ReadonlySet<string> {
  return new Set([
    ...(account.changeEmail ? [] : ['/change-email']),
    ...(account.linking ? [] : ['/link-social']),
    ...(account.delete ? [] : ['/delete-user', '/delete-user/callback']),
  ]);
}

const AUTH_ERROR_CODE_NAMES: ReadonlySet<string> = new Set(Object.values(AUTH_ERROR_CODES));
const isAuthErrorCode = (value: unknown): value is AuthErrorCode =>
  typeof value === 'string' && AUTH_ERROR_CODE_NAMES.has(value);

/**
 * The header the engine reads the client address from when the app names no `clientIp.header`.
 * Only this package writes it: the handler sets it to the socket address and drops any value a
 * caller sent. So without a configured header no request header, `x-forwarded-for` included,
 * can pick a rate-limit bucket.
 */
export const SOCKET_ADDRESS_HEADER = 'x-arki-auth-socket-address';

/** The socket address a runtime puts on the request: `request.ip` from srvx (TanStack Start, Nitro, h3). */
const socketAddressSchema = z.string().min(1);

/**
 * The request the engine sees when no `clientIp.header` is configured: the socket address in
 * {@link SOCKET_ADDRESS_HEADER}, or no address at all (every caller then shares one budget).
 */
async function withSocketAddress(request: Request): Promise<Request> {
  const ip: unknown = Reflect.get(request, 'ip');
  const address = is(ip, socketAddressSchema) ? ip : undefined;
  if (address === undefined && !request.headers.has(SOCKET_ADDRESS_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(SOCKET_ADDRESS_HEADER);
  if (address !== undefined) headers.set(SOCKET_ADDRESS_HEADER, address);
  // Field by field, not `new Request(request, ...)`: a runtime's own request class (srvx on Node)
  // is not a native `Request`. Auth bodies are small JSON, so the body is read whole.
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
  return new Request(request.url, { method: request.method, headers, body, signal: request.signal });
}

/**
 * The caller's headers for an in-process engine call. Browser-only headers are dropped: they would
 * make the engine treat a server call as a form post and check its origin. A caller's
 * {@link SOCKET_ADDRESS_HEADER} is dropped too: headers carry no socket. The rest, the configured
 * client-IP header and user agent included, pass as they are.
 */
function engineHeadersOf(headers: Headers): Headers {
  const result = new Headers(headers);
  for (const name of headers.keys()) {
    if (/^(?:cookie|origin|referer|authorization|content-length|sec-fetch-.*)$/.test(name)) result.delete(name);
  }
  result.delete(SOCKET_ADDRESS_HEADER);
  result.set('content-type', 'application/json');
  return result;
}

const jsonError = (error: AuthError): Response =>
  Response.json({ code: error.code, message: error.message }, { status: error.status });

/** Runtime values as the builder reads them: `providers` is checked at boot, not trusted. */
export type CheckedRuntime = Omit<AuthRuntime<AuthDefinition>, 'providers'> & { readonly providers?: unknown };

/**
 * The bindings as the builder reads them. `createAuth` narrows `runtime` to the definition and
 * checks `sessionCreating`'s exact return type; the builder only needs its column values.
 */
export type CheckedBindings<D extends AuthDefinition, T extends AuthTables> = Omit<
  AuthBindings<D, T>,
  'runtime' | 'on'
> & {
  readonly runtime: () => CheckedRuntime;
  readonly on?: AuthBindingEvents<D, T, SessionValues<T>>;
};

/**
 * Builds the auth. Every mistake a deployment can make is refused here, at boot: unknown fields
 * and missing provider credentials (`E001`), a weak secret in production (`E002`), mail methods
 * without a mailer (`E003`), missing workspace tables (`E007`), no shared rate-limit store in
 * production (`E001`).
 */
export function buildAuth<D extends AuthDefinition, T extends AuthTables>(
  definition: D,
  bindings: CheckedBindings<D, T>,
): Auth<D, T> {
  type U = UserRow<D, T>;
  type P = PrincipalFor<D, T>;

  const resolved = resolveDefinition(definition);
  const runtime = bindings.runtime();
  assertUrl(runtime.url, '`runtime().url`');
  if (runtime.productionUrl !== undefined) assertUrl(runtime.productionUrl, '`runtime().productionUrl`');
  assertAuthSecret(runtime.secret, runtime.production);

  const tables: AuthTables = bindings.tables;
  if (resolved.workspaces !== undefined) assertWorkspaceTables(tables, resolved.workspaces.teams);
  assertIdDefaults(tables, resolved.workspaces);
  const sendsMail =
    resolved.methods.includes('password') || resolved.methods.includes('magicLink') || resolved.account.changeEmail;
  if (sendsMail && bindings.mail === undefined) {
    throw new AuthError(
      AUTH_ERROR_CODES.mailRequired,
      '[@arki/auth] `password`, `magicLink` and `account.changeEmail` send mail: bind `mail` (the Dot `mail` service).',
    );
  }
  if (runtime.production && bindings.rateLimit === undefined) {
    invalid(
      "Production needs a rate-limit store: `rateLimit: { store: kv }` (shared), or `{ store: 'memory' }` (per process).",
    );
  }
  if (runtime.production && bindings.rateLimit === false) {
    invalid('`rateLimit: false` is for tests and local dev; production needs `rateLimit: { store: kv }`.');
  }
  const rateLimitStore = bindings.rateLimit === false ? undefined : bindings.rateLimit?.store;
  if (rateLimitStore === 'memory') {
    log.warn(
      'Auth "{app}" counts rate limits in memory, per process: each replica has its own budget. Bind a shared `@arki/kv` store to share one.',
      { app: resolved.app.name, key: resolved.app.key },
    );
  }
  const providers: unknown = runtime.providers;
  const socialProviders = socialProvidersFor(resolved.methods, providers);
  const additionalFields = additionalFieldsFromColumns(tables.User, resolved.fields, resolved.signUpFields);

  const emit = createEmitter(bindings.on);
  const onSessionCreating = bindings.on?.sessionCreating;
  const onSessionCreated = bindings.on?.sessionCreated;
  const engineSessionColumns: ReadonlySet<string> = new Set(ENGINE_SESSION_COLUMNS);
  // The organization plugin declares the workspace columns itself.
  const pluginSessionColumns: ReadonlySet<string> = new Set(
    resolved.workspaces === undefined ? [] : ['activeOrganizationId', 'activeTeamId'],
  );
  const appSessionColumns = new Set(
    Object.keys(getTableColumns(tables.Session)).filter(name => !engineSessionColumns.has(name)),
  );
  const sessionFields =
    onSessionCreating === undefined
      ? {}
      : additionalFieldsFromColumns(
          tables.Session,
          [...appSessionColumns].filter(name => !pluginSessionColumns.has(name)),
          [],
          false,
        );
  const roles = bindings.roles ?? (() => []);
  const workspaces = resolved.workspaces !== undefined;
  const closedPaths = closedAccountPaths(resolved.account);

  const engine = betterAuth(
    engineOptions({
      definition: resolved,
      runtime: {
        url: runtime.url,
        productionUrl: runtime.productionUrl,
        secret: runtime.secret,
        production: runtime.production,
        trustedOrigins: runtime.trustedOrigins ?? [],
        clientIpHeader: runtime.clientIp?.header ?? SOCKET_ADDRESS_HEADER,
      },
      db: bindings.db,
      provider: dialectOf(bindings.db) ?? invalid('`db` is neither a Drizzle Postgres nor a Drizzle SQLite database.'),
      tables,
      additionalFields,
      sessionFields,
      socialProviders,
      mail:
        bindings.mail === undefined
          ? undefined
          : authMail({
              mail: bindings.mail,
              templates: bindings.templates,
              appName: resolved.app.name,
              brand: bindings.mailBrand,
            }),
      rateLimit:
        rateLimitStore === undefined || rateLimitStore === 'memory'
          ? rateLimitStore
          : kvRateLimitStorage(rateLimitStore),
      methodOfSource,
      plugins: bindings.plugins ?? [],
      callbacks: {
        beforeUserCreate:
          bindings.on?.beforeUserCreate === undefined
            ? undefined
            : async event => {
                await bindings.on?.beforeUserCreate?.(event);
              },
        userCreated: async (user, path, body) => {
          const method =
            path === undefined
              ? undefined
              : (signInMethodOf(path, resolved.methods) ?? idTokenMethodOf(path, body, resolved.methods));
          if (method === undefined) return;
          await emit.userCreated({ user: toUserRow<U>(user, resolved.fields), method });
        },
        passwordReset: userId => emit.passwordChanged({ userId, reason: 'reset' }),
        sessionCreating:
          onSessionCreating === undefined
            ? undefined
            : async (session, request) => {
                const userId: unknown = Reflect.get(session, 'userId');
                if (!isUserId<UserIdOf<T>>(userId)) {
                  throw new AuthError(
                    AUTH_ERROR_CODES.principalShape,
                    "[@arki/auth] The engine's session lacks its userId.",
                  );
                }
                let values: SessionValues<T> | void;
                try {
                  values = await onSessionCreating({ userId, ...(request !== undefined && { request }) });
                } catch (error) {
                  if (isAuthError(error)) throw sessionRefused(error);
                  throw error;
                }
                const entries = typeof values === 'object' ? Object.entries(values) : [];
                const unknown = entries.map(([name]) => name).filter(name => !appSessionColumns.has(name));
                if (unknown.length > 0) {
                  invalid(
                    `\`sessionCreating\` returned ${unknown.join(', ')}: not one of the app's own Session columns.`,
                  );
                }
                return Object.fromEntries(entries);
              },
        sessionCreated: async session => {
          if (onSessionCreated === undefined) return;
          await runObserver('sessionCreated', () => {
            const userId: unknown = Reflect.get(session, 'userId');
            if (!isUserId<UserIdOf<T>>(userId)) throw new Error("The engine's session lacks its userId.");
            return onSessionCreated({ userId, session: toPrincipalSession<SessionIdOf<T>>(session) });
          });
        },
      },
    }),
  );

  const engineContext = () => engine.$context;
  const sessionCookieName = async () => {
    const context = await engineContext();
    return context.authCookies.sessionToken.name;
  };

  async function principal(headers: Headers): Promise<P | null> {
    const bearerToken = bearerTokenOf(headers);
    const cookieName = await sessionCookieName();
    if (bearerToken !== undefined && hasCookie(headers, cookieName)) {
      throw new AuthError(
        AUTH_ERROR_CODES.unauthenticated,
        'A request carries both a session cookie and a bearer token.',
      );
    }
    const found = await engine.api.getSession({ headers });
    if (found === null) return null;
    const via: PrincipalVia = bearerToken !== undefined && resolved.sessions.bearer ? 'bearer' : 'cookie';
    return toPrincipal<U, SessionIdOf<T>>(
      { user: found.user, session: found.session, fields: resolved.fields, via, workspaces },
      roles,
    );
  }

  /** The principal of a request whose credentials may be wrong; events never fail the request. */
  const principalOrNull = (headers: Headers): Promise<P | null> => principal(headers).catch(() => null);

  async function handler(incoming: Request): Promise<Response> {
    const request = runtime.clientIp === undefined ? await withSocketAddress(incoming) : incoming;
    const path = enginePath(request);
    if (closedPaths.has(path.replace(/\/+$/, ''))) return new Response(null, { status: 404 });
    const method = signInMethodOf(path, resolved.methods);
    const before = path === '/sign-out' || path === '/change-password' ? await principalOrNull(request.headers) : null;

    let response: Response;
    try {
      response = await engine.handler(request);
    } catch (error) {
      if (isAuthError(error) && error.code === AUTH_ERROR_CODES.storeUnavailable) return jsonError(error);
      throw error;
    }

    if (response.status === 429) {
      response = await withHeaders(response, { 'retry-after': response.headers.get('x-retry-after') ?? '60' });
    }

    if (method !== undefined) {
      const requestId = requestIdOf(request.headers);
      const cookie = sessionCookieOf(response, await sessionCookieName());
      const token = response.headers.get('set-auth-token');
      const signedIn =
        cookie === undefined && token === null
          ? null
          : await principalOrNull(
              new Headers(cookie === undefined ? { authorization: `Bearer ${token}` } : { cookie }),
            );
      if (signedIn === null) {
        const reason = await failureOf(response);
        if (reason !== undefined && !isFailure(requestId)) await emit.signInFailed({ method, reason, requestId });
      } else if (!isFailure(requestId)) {
        await emit.signIn({ principal: signedIn, method, requestId });
      }
    }
    if (before !== null && response.ok) {
      if (path === '/sign-out') await emit.signOut({ principal: before });
      else await emit.passwordChanged({ userId: before.user.id, reason: 'change' });
    }
    return response;
  }

  const supportsIdToken = (provider: SocialMethod): provider is IdTokenMethodsOf<D> =>
    isIdTokenMethod(provider) && resolved.methods.includes(provider);

  async function signInWithIdToken(input: IdTokenSignIn<D>): Promise<IdTokenSession<P> | null> {
    const { provider, idToken, nonce, headers } = input;
    // Read as a plain string: a caller without the types can pass anything.
    const name: string = provider;
    if (!isSocialMethod(name) || !supportsIdToken(name)) {
      invalid(`"${name}" is not an enabled id-token method (${ID_TOKEN_METHODS.join(', ')}).`);
    }
    if (!resolved.sessions.bearer) {
      invalid('`signInWithIdToken` needs `sessions: { bearer: true }`: the native app keeps a bearer token.');
    }
    const requestId = requestIdOf(headers);
    const refused = async (reason: SignInFailure) => {
      if (!isFailure(requestId)) await emit.signInFailed({ method: provider, reason, requestId });
      return null;
    };

    // Through the engine's own router, so the sign-in rate limit applies exactly as on the HTTP
    // routes: the same store, rule and client-IP header. A failing store throws `E503` from here.
    const response = await engine.handler(
      new Request(new URL(`${AUTH_BASE_PATH}/sign-in/social`, runtime.url), {
        method: 'POST',
        headers: engineHeadersOf(headers),
        body: JSON.stringify({ provider, idToken: { token: idToken, ...(nonce !== undefined && { nonce }) } }),
      }),
    );
    if (!response.ok) {
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      const code: unknown = is(body, recordSchema) ? Reflect.get(body, 'code') : undefined;
      const message: unknown = is(body, recordSchema) ? Reflect.get(body, 'message') : undefined;
      // `sessionCreating` refused the session with the app's own code.
      if (isAuthErrorCode(code)) throw new AuthError(code, typeof message === 'string' ? message : code);
      const reason = await failureOf(response);
      if (reason === 'rateLimited') {
        if (!isFailure(requestId)) await emit.signInFailed({ method: provider, reason, requestId });
        const retryAfter = Number(response.headers.get('x-retry-after'));
        throw new AuthError(AUTH_ERROR_CODES.rateLimited, 'Too many sign-in attempts.', {
          ...(Number.isFinite(retryAfter) && retryAfter > 0 && { retryAfter }),
        });
      }
      if (reason === 'credentials' || reason === 'unverified') return refused(reason);
      throw new Error(
        `[@arki/auth] The engine answered an id-token sign-in with ${response.status}${typeof code === 'string' ? ` ${code}` : ''}.`,
      );
    }
    const token = response.headers.get('set-auth-token');
    const signedIn = token === null ? null : await principal(new Headers({ authorization: `Bearer ${token}` }));
    if (token === null || signedIn === null) {
      throw new Error('[@arki/auth] The engine accepted the id token but returned no usable bearer token.');
    }
    if (!isFailure(requestId)) await emit.signIn({ principal: signedIn, method: provider, requestId });
    log.debug('Signed in with a {provider} id token', { provider: name });
    return { token, principal: signedIn };
  }

  const testing: AuthTestingApi<U> = {
    async signIn(user, options = {}) {
      if (runtime.production) {
        throw new AuthError(AUTH_ERROR_CODES.testingInProduction, 'auth.testing is not available in production.');
      }
      const via = options.via ?? 'cookie';
      if (via === 'bearer' && !resolved.sessions.bearer) invalid('`via: bearer` needs `sessions: { bearer: true }`.');
      const context = await engineContext();
      const email = user.email.toLowerCase();
      const existing = await context.internalAdapter.findUserByEmail(email);
      // Arranging state, not a sign-up: the row goes in through the engine's adapter, past the
      // sign-up gates (`beforeUserCreate`), as an already-verified user.
      const row: object =
        existing?.user ??
        (await context.adapter.create<Record<string, unknown>, object>({
          model: 'user',
          data: {
            name: email.split('@')[0] ?? email,
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...user,
            email,
          },
        }));
      const found = toUserRow<U>(row, resolved.fields);
      if (options.password !== undefined) {
        if (!resolved.methods.includes('password')) invalid('`password` needs the `password` method.');
        // The user's password becomes this one, so a form-driven test can sign in with it.
        const hash = await context.password.hash(options.password);
        const accounts = await context.internalAdapter.findAccounts(found.id);
        const credential = accounts.find(account => account.providerId === 'credential');
        await (credential === undefined
          ? context.internalAdapter.linkAccount({
              userId: found.id,
              providerId: 'credential',
              accountId: found.id,
              password: hash,
            })
          : context.internalAdapter.updateAccount(credential.id, { password: hash }));
      }
      const session = await context.internalAdapter.createSession(found.id);
      const signed = `${session.token}.${await makeSignature(session.token, context.secret)}`;
      const headers = new Headers(
        via === 'bearer'
          ? { authorization: `Bearer ${signed}` }
          : { cookie: `${context.authCookies.sessionToken.name}=${signed}` },
      );
      log.debug('Signed in a test user by {via}', { via });
      return { headers, user: found };
    },
  };

  log.debug('Auth "{key}" built with {methods}', { key: resolved.app.key, methods: resolved.methods.join(', ') });

  return {
    definition,
    handler: request => observeAuth('auth.handler', () => handler(request)),
    principal: headers => observeAuth('auth.principal', () => principal(headers)),
    sessions: createSessions<P, SessionIdOf<T>, UserIdOf<T>>(engineContext),
    supportsIdToken,
    signInWithIdToken: input => observeAuth('auth.sign_in_with_id_token', () => signInWithIdToken(input)),
    engine,
    testing,
  };
}
