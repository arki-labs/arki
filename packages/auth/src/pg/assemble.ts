/**
 * The one place the engine's options are built. Plain data in, `BetterAuthOptions` out: the
 * plugin list is a plain array of the engine's own plugin values, with no cast.
 */
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { expo } from '@better-auth/expo';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { bearer, magicLink, oAuthProxy, organization } from 'better-auth/plugins';

import type { Dialect } from '@arki/db/dialect';

import type { AuthMethod, ResolvedDefinition } from '../definition.js';
import type { AdditionalFields } from './fields.js';
import type { AuthMail, AuthMailKind } from './mail.js';
import type { RateLimitStorage } from './security/kv-storage.js';
import type { AuthDb, AuthTable, AuthTables } from './types.js';
import { PASSWORD_MIN_LENGTH } from '../constants.js';
import { AUTH_ERROR_CODES, AuthError, isAuthError } from '../errors.js';
import { AUTH_BASE_PATH } from './events.js';
import { LINK_MINUTES } from './mail.js';
import { CLIENT_KEY_KIND_HEADER } from './security/client-key.js';

export type SocialProviders = NonNullable<BetterAuthOptions['socialProviders']>;

export type EngineRuntime = {
  readonly url: string;
  readonly productionUrl: string | undefined;
  readonly secret: string | undefined;
  readonly production: boolean;
  readonly trustedOrigins: readonly string[];
  /** The one header the engine reads the client address from. Never a caller-set default. */
  readonly clientIpHeader: string;
};

export type EngineCallbacks = {
  /** Refuses a user creation by throwing `AuthError`. Absent: no gate (and no engine validation hook). */
  readonly beforeUserCreate:
    ((event: { email: string; method: AuthMethod; request?: Request }) => Promise<void>) | undefined;
  /** `body` is the request body: an id-token sign-in names its provider there, not in the path. */
  readonly userCreated: (user: object, path: string | undefined, body: unknown) => Promise<void>;
  readonly passwordReset: (userId: string) => Promise<void>;
  /** The app's values for a new session's own columns. Absent: no hook. */
  readonly sessionCreating:
    ((session: object, request: Request | undefined) => Promise<Readonly<Record<string, unknown>>>) | undefined;
  readonly sessionCreated: (session: object) => Promise<void>;
};

export type EngineInput = {
  readonly definition: ResolvedDefinition;
  readonly runtime: EngineRuntime;
  readonly db: AuthDb;
  /** The adapter's dialect, read from `db`. */
  readonly provider: Dialect;
  readonly tables: AuthTables;
  readonly additionalFields: AdditionalFields;
  /** The app's own session columns `sessionCreating` writes; the engine drops fields it does not know. */
  readonly sessionFields: AdditionalFields;
  readonly socialProviders: SocialProviders;
  readonly mail: AuthMail | undefined;
  /** The shared store, `'memory'` for the engine's per-process limiter, or `undefined` for none. */
  readonly rateLimit: RateLimitStorage | 'memory' | undefined;
  readonly callbacks: EngineCallbacks;
  readonly methodOfSource: (source: { method: string; oauth?: { providerId: string } }) => AuthMethod | undefined;
  readonly plugins: readonly BetterAuthPlugin[];
};

/** The engine's model names mapped to the app's tables. */
export function engineSchema(tables: AuthTables): Record<string, AuthTable> {
  const { User, Session, Account, Verification, Organization, Member, Invitation, Team, TeamMember } = tables;
  return {
    user: User,
    session: Session,
    account: Account,
    verification: Verification,
    ...(Organization && { organization: Organization }),
    ...(Member && { member: Member }),
    ...(Invitation && { invitation: Invitation }),
    ...(Team && { team: Team }),
    ...(TeamMember && { teamMember: TeamMember }),
  };
}

const originOf = (url: string): string => new URL(url).origin;

export function engineOptions(input: EngineInput): BetterAuthOptions {
  const { definition, runtime, callbacks } = input;
  const { methods, verifyEmail, sessions, workspaces, account } = definition;
  const { beforeUserCreate, sessionCreating } = callbacks;
  const password = methods.includes('password');
  const verifiesSignUp = password && verifyEmail !== 'none';

  // E003 is thrown before this runs whenever a method sends mail; this keeps the closures total.
  const sendLink = async (kind: AuthMailKind, to: string, url: string, request: Request | undefined) => {
    if (input.mail === undefined) throw new AuthError(AUTH_ERROR_CODES.mailRequired, 'No mailer is bound.');
    await input.mail.send(kind, to, url, request);
  };

  const plugins: BetterAuthPlugin[] = [
    ...(runtime.productionUrl !== undefined && originOf(runtime.productionUrl) !== originOf(runtime.url)
      ? [oAuthProxy({ currentURL: runtime.url, productionURL: runtime.productionUrl })]
      : []),
    ...(definition.expo ? [expo()] : []),
    ...(methods.includes('magicLink')
      ? [
          magicLink({
            storeToken: 'hashed',
            expiresIn: LINK_MINUTES.magicLink * 60,
            disableSignUp: !definition.magicLink.signUp,
            sendMagicLink: ({ email, url }, ctx) => sendLink('magicLink', email, url, ctx?.request),
          }),
        ]
      : []),
    ...(workspaces === undefined ? [] : [organization({ teams: { enabled: workspaces.teams } })]),
    ...(sessions.bearer ? [bearer()] : []),
    ...input.plugins,
  ];

  return {
    appName: definition.app.name,
    baseURL: runtime.url,
    basePath: AUTH_BASE_PATH,
    secret: runtime.secret,
    database: drizzleAdapter(input.db, { provider: input.provider, schema: engineSchema(input.tables) }),
    trustedOrigins: [
      originOf(runtime.url),
      ...(runtime.productionUrl === undefined ? [] : [originOf(runtime.productionUrl)]),
      ...runtime.trustedOrigins,
    ],
    socialProviders: input.socialProviders,
    plugins,
    user: {
      additionalFields: input.additionalFields,
      ...(beforeUserCreate !== undefined && {
        async validateUserInfo({ user, source }, ctx) {
          const method = input.methodOfSource(source);
          if (source.action !== 'create-user' || method === undefined || typeof user.email !== 'string') {
            return;
          }
          try {
            await beforeUserCreate({ email: user.email, method, request: ctx.request });
            return;
          } catch (error) {
            if (isAuthError(error)) return { error: error.code, errorDescription: error.message };
            throw error;
          }
        },
      }),
      // The new address gets the verify link (`emailVerification` below); it changes when the link is used.
      changeEmail: { enabled: account.changeEmail },
      // No confirmation mail: a fresh session or the password is the proof.
      deleteUser: { enabled: account.delete },
    },
    account: { accountLinking: { enabled: account.linking } },
    databaseHooks: {
      user: { create: { after: (user, ctx) => callbacks.userCreated(user, ctx?.path, ctx?.body) } },
      // Every session the engine writes goes through here: every sign-in path and `actingAs`.
      session: {
        create: {
          before: async (session, ctx) => {
            const columns = sessionCreating === undefined ? {} : await sessionCreating(session, ctx?.request);
            // An account key is not where the client is: never record it as the session's address.
            const accountKeyed = ctx?.request?.headers.get(CLIENT_KEY_KIND_HEADER) === 'account';
            return { data: accountKeyed ? { ...columns, ipAddress: null } : columns };
          },
          after: session => callbacks.sessionCreated(session),
        },
      },
    },
    session: {
      additionalFields: input.sessionFields,
      expiresIn: sessions.expiresIn,
      updateAge: sessions.refreshEvery,
      storeSessionInDatabase: true,
      // Off, so a revoked session fails on the very next request.
      cookieCache: { enabled: false },
    },
    ...(password && {
      emailAndPassword: {
        enabled: true,
        minPasswordLength: PASSWORD_MIN_LENGTH,
        requireEmailVerification: verifyEmail === 'require',
        autoSignIn: verifyEmail !== 'require',
        revokeSessionsOnPasswordReset: true,
        resetPasswordTokenExpiresIn: LINK_MINUTES.resetPassword * 60,
        sendResetPassword: ({ user, url }, request) => sendLink('resetPassword', user.email, url, request),
        onPasswordReset: ({ user }) => callbacks.passwordReset(user.id),
      },
    }),
    // Change email needs the verify link too, even when sign-up sends none.
    ...((verifiesSignUp || account.changeEmail) && {
      emailVerification: {
        sendOnSignUp: verifiesSignUp,
        autoSignInAfterVerification: true,
        expiresIn: LINK_MINUTES.verifyEmail * 60,
        sendVerificationEmail: ({ user, url }, request) => sendLink('verifyEmail', user.email, url, request),
      },
    }),
    hooks: {
      // A password change always ends the other sessions: a stolen session cannot keep the account.
      before: createAuthMiddleware(async ctx => {
        if (ctx.path !== '/change-password') return;
        const body: unknown = ctx.body;
        if (typeof body !== 'object' || body === null) throw new APIError('BAD_REQUEST');
        return { context: { body: { ...body, revokeOtherSessions: true } } };
      }),
    },
    rateLimit:
      input.rateLimit === undefined
        ? { enabled: false }
        : input.rateLimit === 'memory'
          ? { enabled: true, storage: 'memory' }
          : { enabled: true, customStorage: input.rateLimit },
    advanced: {
      cookiePrefix: `auth-${definition.app.key}`,
      useSecureCookies: runtime.production,
      // Explicit: the engine turns both checks off whenever it thinks it runs under test.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      database: { generateId: false },
      // Always named: the engine's default is the caller-set `x-forwarded-for`.
      ipAddress: { ipAddressHeaders: [runtime.clientIpHeader] },
    },
  };
}
