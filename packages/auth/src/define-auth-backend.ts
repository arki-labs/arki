import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import type { DB } from 'better-auth/adapters/drizzle';
import { expo } from '@better-auth/expo';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink, oAuthProxy } from 'better-auth/plugins';
import { tanstackStartCookies } from 'better-auth/tanstack-start';

import { createPrefixedId } from '@arki/db/id';
import { getLogger } from '@arki/log';

import type { WorkspacePluginOptions } from './workspaces/server/plugin';
import { betterAuth } from './create-auth';
import { organizationPlugin } from './workspaces/server/plugin';

const authLogger = getLogger('arki:auth');

type Provider = { clientId: string; clientSecret: string };
type AppleProvider = Provider & { appBundleIdentifier?: string };

type AuthSchema = {
  user: unknown;
  account: unknown;
  session: unknown;
  verification: unknown;
  [key: string]: unknown;
};

export type GenerateIdHook = NonNullable<NonNullable<BetterAuthOptions['advanced']>['database']>['generateId'];

export type DefineAuthBackendOptions = {
  db: DB;
  schema: AuthSchema;
  appName: string;
  appKey: string;
  baseUrl: string;
  productionUrl: string;
  /**
   * Secret used by better-auth to sign session cookies and verification tokens.
   * If `undefined`, better-auth falls back to `process.env.BETTER_AUTH_SECRET`
   * (kept in sync by the `betterAuth` wrapper). Production callers must always
   * provide one — leaving it `undefined` is a footgun in non-server runtimes.
   */
  secret: string | undefined;

  generateId?: GenerateIdHook;
  /**
   * Pluralization mode for the drizzle adapter's model lookup.
   *
   * `false` (default) — schema keys must be SINGULAR (`user`, `account`,
   * `session`, `verification`). Matches games-platform's working pattern.
   *
   * `true` — schema keys must be PLURAL (`users`, `accounts`, `sessions`,
   * `verifications`). Use only if your schema map is keyed plural.
   *
   * Either way, the actual DB table names are whatever you set in `.table(...)`.
   */
  usePlural?: boolean;

  magicLink?: {
    // `request` is the originating HTTP request (when available). Shared
    // backends serving several brands use it to resolve which brand sent the
    // sign-in (e.g. from the Origin/Host header). Optional and additive —
    // single-brand callers can ignore it.
    send: (args: { email: string; url: string; token: string; request?: Request }) => Promise<void> | void;

    /**
     * When `true`, magic-link requests for a non-existent email are refused
     * instead of auto-creating a user (magic-link becomes sign-in-only).
     * Forwarded verbatim to Better Auth's `magicLink({ disableSignUp })`.
     */
    disableSignUp?: boolean;
  };

  socialProviders?: {
    google?: Provider;
    apple?: AppleProvider;
    facebook?: Provider;
    microsoft?: Provider & { scope?: string[] };
  };

  enableExpo?: boolean;
  /**
   * When `emailAndPassword` is unset, the factory auto-enables a minimal
   * email/password config in non-production (NODE_ENV !== 'production') so the
   * shared `createE2EHandler` can sign in via /sign-in/email. Pass an explicit
   * config to override (e.g. to wire production reset-password emails).
   */
  enableEmailAndPassword?: boolean;
  emailAndPassword?: BetterAuthOptions['emailAndPassword'];
  emailVerification?: BetterAuthOptions['emailVerification'];
  databaseHooks?: BetterAuthOptions['databaseHooks'];
  user?: BetterAuthOptions['user'];
  account?: BetterAuthOptions['account'];
  trustedOrigins?: BetterAuthOptions['trustedOrigins'];
  extraPlugins?: BetterAuthPlugin[];

  /**
   * Team Workspaces (D-WS-001). When `enabled`, the Better Auth organization
   * plugin is registered and the app must include the org tables
   * (`organization`, `member`, `invitation`, plus `team`/`teamMember` when
   * `teams`) in `schema`. The scoping kernel + flag wiring live in
   * `@arki/auth/workspaces`. See
   * `apps/avocabo/docs/features/team-workspaces/pilot-spec.md`.
   */
  organization?: { enabled: boolean } & WorkspacePluginOptions;
};

const defaultGenerateId: GenerateIdHook = ({ model }) => {
  const slug = String(model).replace(/s$/, '');
  return `${slug}_${crypto.randomUUID().replace(/-/g, '')}`;
};

/** Drop the `enabled` flag, leaving the plugin options for `organizationPlugin`. */
function stripEnabled(o: { enabled: boolean } & WorkspacePluginOptions): WorkspacePluginOptions {
  const { enabled: _enabled, ...rest } = o;
  return rest;
}

type PrefixMap = {
  user?: string;
  session?: string;
  account?: string;
  verification?: string;
  fallback?: (model: string) => string;
};

/**
 * Builds a `generateId` hook that uses `@arki/db/createPrefixedId` with
 * per-model prefixes. The default matches the legacy convention used across
 * almost every Arki app (`u_xxx`, `sess_xxx`, `acc_xxx`, `verif_xxx`).
 *
 * Override individual prefixes for apps that deviate — e.g. Kapodopera's
 * underscore-free style:
 *
 *   createPrefixedIdHook({ user: 'usr', session: 'sess', account: 'acc', verification: 'verif' })
 */
export function createPrefixedIdHook(prefixes: PrefixMap = {}): GenerateIdHook {
  const resolved: Required<Omit<PrefixMap, 'fallback'>> = {
    user: prefixes.user ?? 'u_',
    session: prefixes.session ?? 'sess_',
    account: prefixes.account ?? 'acc_',
    verification: prefixes.verification ?? 'verif_',
  };
  const fallback = prefixes.fallback ?? ((model: string) => `${model}_`);
  return ({ model }) => {
    const key = String(model).replace(/s$/, '') as keyof typeof resolved;
    return createPrefixedId(resolved[key] ?? fallback(String(model)));
  };
}

export function defineAuthBackend(options: DefineAuthBackendOptions) {
  const {
    db,
    schema,
    appName,
    appKey,
    baseUrl,
    productionUrl,
    secret,
    generateId,
    usePlural = false,
    magicLink: magicLinkConfig,
    socialProviders,
    enableExpo = true,
    enableEmailAndPassword,
    emailAndPassword,
    emailVerification,
    databaseHooks,
    user,
    account,
    trustedOrigins,
    extraPlugins = [],
    organization,
  } = options;

  const cookiePrefix = `auth-${appKey}`;
  const isDevOrTest = process.env['NODE_ENV'] !== 'production';
  // Caller-provided emailAndPassword always wins. Otherwise auto-enable in
  // dev/test (so `createE2EHandler` works without per-app opt-in).
  const shouldAutoEnableEmailAndPassword = !emailAndPassword && (enableEmailAndPassword ?? isDevOrTest);

  const plugins: BetterAuthPlugin[] = [
    oAuthProxy({ currentURL: baseUrl, productionURL: productionUrl }) as BetterAuthPlugin,
    ...(enableExpo ? [expo() as BetterAuthPlugin] : []),
    ...(magicLinkConfig
      ? [
          magicLink({
            disableSignUp: magicLinkConfig.disableSignUp,
            sendMagicLink: async ({ email, url, token }, ctx) => {
              await magicLinkConfig.send({ email, url, token, request: ctx?.request });
            },
          }) as BetterAuthPlugin,
        ]
      : []),
    ...(organization?.enabled ? [organizationPlugin(stripEnabled(organization))] : []),
    ...extraPlugins,
    tanstackStartCookies(),
  ];

  return betterAuth({
    appName,
    baseURL: baseUrl,
    secret,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: schema as Parameters<typeof drizzleAdapter>[1]['schema'],
      usePlural,
    }),
    advanced: {
      cookiePrefix,
      database: { generateId: generateId ?? defaultGenerateId },
    },
    plugins,
    databaseHooks,
    user,
    account,
    trustedOrigins,
    socialProviders: socialProviders
      ? {
          ...(socialProviders.google && { google: socialProviders.google }),
          ...(socialProviders.apple && { apple: socialProviders.apple }),
          ...(socialProviders.facebook && { facebook: socialProviders.facebook }),
          ...(socialProviders.microsoft && { microsoft: socialProviders.microsoft }),
        }
      : undefined,
    ...(emailAndPassword
      ? { emailAndPassword }
      : shouldAutoEnableEmailAndPassword
        ? {
            emailAndPassword: {
              enabled: true,
              autoSignIn: true,
              sendResetPassword: async () => {
                authLogger.warn(
                  'sendResetPassword called on auto-enabled emailAndPassword (dev/test). Pass `emailAndPassword` to defineAuthBackend for production.',
                );
              },
            },
          }
        : {}),
    ...(emailVerification && { emailVerification }),
  });
}

export type DefinedAuth = ReturnType<typeof defineAuthBackend>;
