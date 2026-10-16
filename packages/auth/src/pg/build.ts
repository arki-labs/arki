/**
 * The auth builder behind `createAuth` and `testAuth`.
 */
import { betterAuth } from 'better-auth';
import { makeSignature } from 'better-auth/crypto';
import { getTableColumns } from 'drizzle-orm';

import type { AuthDefinition, AuthMethod, ResolvedDefinition, SocialMethod } from '../definition.js';
import type { PrincipalVia, SessionIdOf, UserIdOf, UserRow } from '../principal.js';
import type { SocialProviders } from './assemble.js';
import type { AuthEngine } from './engine.js';
import type {
  AuthBindings,
  AuthRuntime,
  AuthSessions,
  AuthTables,
  AuthTestingApi,
  PrincipalFor,
  ProviderCredentialsMap,
} from './types.js';
import { isSocialMethod, resolveDefinition } from '../definition.js';
import { AUTH_ERROR_CODES, AuthError, isAuthError } from '../errors.js';
import { log } from '../log.js';
import { toPrincipal, toUserRow } from '../principal.js';
import { engineOptions } from './assemble.js';
import { createEmitter, enginePath, failureOf, methodOfSource, requestIdOf, signInMethodOf } from './events.js';
import { additionalFieldsFromColumns } from './fields.js';
import { authMail } from './mail.js';
import { assertAuthSecret } from './secret.js';
import { kvRateLimitStorage } from './security/kv-storage.js';
import { createSessions } from './sessions.js';

/** A working auth. Build it with {@link createAuth}. */
export type Auth<D extends AuthDefinition, T extends AuthTables> = {
  readonly definition: D;
  /** Serves the engine's routes under `/api/auth`. */
  readonly handler: (request: Request) => Promise<Response>;
  /** Who is calling, or `null` for a guest. A cookie and a bearer token together are `ARKI_AUTH_E401`. */
  readonly principal: (headers: Headers) => Promise<PrincipalFor<D, T> | null>;
  readonly sessions: AuthSessions<PrincipalFor<D, T>, SessionIdOf<T>, UserIdOf<T>>;
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
    typeof providers === 'object' && providers !== null ? Reflect.get(providers, method) : undefined;
  const field = (key: string): unknown =>
    typeof entry === 'object' && entry !== null ? Reflect.get(entry, key) : undefined;
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
  if (!URL.canParse(url)) invalid(`${label} "${url}" is not an absolute URL.`);
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

/** A copy of the response with extra headers (engine responses may have immutable headers). */
function withHeaders(response: Response, extra: Readonly<Record<string, string>>): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** The engine routes an `account` switch opens. While the switch is off they answer 404. */
function closedAccountPaths(account: ResolvedDefinition['account']): ReadonlySet<string> {
  return new Set([
    ...(account.changeEmail ? [] : ['/change-email']),
    ...(account.linking ? [] : ['/link-social']),
    ...(account.delete ? [] : ['/delete-user', '/delete-user/callback']),
  ]);
}

const jsonError = (error: AuthError): Response =>
  Response.json({ code: error.code, message: error.message }, { status: error.status });

/** Runtime values as the builder reads them: `providers` is checked at boot, not trusted. */
export type CheckedRuntime = Omit<AuthRuntime<AuthDefinition>, 'providers'> & { readonly providers?: unknown };

/** The bindings as the builder reads them. `createAuth` narrows `runtime` to the definition. */
export type CheckedBindings<D extends AuthDefinition, T extends AuthTables> = Omit<AuthBindings<D, T>, 'runtime'> & {
  readonly runtime: () => CheckedRuntime;
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
  const sendsMail =
    resolved.methods.includes('password') || resolved.methods.includes('magicLink') || resolved.account.changeEmail;
  if (sendsMail && bindings.mail === undefined) {
    throw new AuthError(
      AUTH_ERROR_CODES.mailRequired,
      '[@arki/auth] `password`, `magicLink` and `account.changeEmail` send mail: bind `mail` (the Dot `mail` service).',
    );
  }
  if (runtime.production && bindings.rateLimit === undefined) {
    invalid('Production needs a shared rate-limit store: `rateLimit: { store: kv }`.');
  }
  if (runtime.production && bindings.rateLimit === false) {
    invalid('`rateLimit: false` is for tests and local dev; production needs `rateLimit: { store: kv }`.');
  }
  const providers: unknown = runtime.providers;
  const socialProviders = socialProvidersFor(resolved.methods, providers);
  const additionalFields = additionalFieldsFromColumns(tables.User, resolved.fields, resolved.signUpFields);

  const emit = createEmitter(bindings.on);
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
        clientIpHeader: runtime.clientIp?.header,
      },
      db: bindings.db,
      tables,
      additionalFields,
      socialProviders,
      mail:
        bindings.mail === undefined
          ? undefined
          : authMail({ mail: bindings.mail, templates: bindings.templates, appName: resolved.app.name }),
      rateLimit: bindings.rateLimit ? kvRateLimitStorage(bindings.rateLimit.store) : undefined,
      methodOfSource,
      plugins: bindings.plugins ?? [],
      callbacks: {
        beforeUserCreate:
          bindings.on?.beforeUserCreate === undefined
            ? undefined
            : async event => {
                await bindings.on?.beforeUserCreate?.(event);
              },
        userCreated: async (user, path) => {
          const method = path === undefined ? undefined : signInMethodOf(path, resolved.methods);
          if (method === undefined) return;
          await emit.userCreated({ user: toUserRow<U>(user, resolved.fields), method });
        },
        passwordReset: userId => emit.passwordChanged({ userId, reason: 'reset' }),
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

  async function handler(request: Request): Promise<Response> {
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
      response = withHeaders(response, { 'retry-after': response.headers.get('x-retry-after') ?? '60' });
    }

    if (method !== undefined) {
      const requestId = requestIdOf(request);
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
        if (reason !== undefined) await emit.signInFailed({ method, reason, requestId });
      } else {
        await emit.signIn({ principal: signedIn, method, requestId });
      }
    }
    if (before !== null && response.ok) {
      if (path === '/sign-out') await emit.signOut({ principal: before });
      else await emit.passwordChanged({ userId: before.user.id, reason: 'change' });
    }
    return response;
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
    handler,
    principal,
    sessions: createSessions<P, SessionIdOf<T>, UserIdOf<T>>(engineContext),
    engine,
    testing,
  };
}
