import { expo } from '@better-auth/expo';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { DB } from 'better-auth/adapters/drizzle';
import { magicLink, oAuthProxy } from 'better-auth/plugins';
import { tanstackStartCookies } from 'better-auth/tanstack-start';
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { createLogger } from '@arki/log';

import { betterAuth } from './create-auth';

const authLogger = createLogger('arki:auth');

type Provider = { clientId: string; clientSecret: string };
type AppleProvider = Provider & { appBundleIdentifier?: string };

type AuthSchema = {
  user: unknown;
  account: unknown;
  session: unknown;
  verification: unknown;
  [key: string]: unknown;
};

export type GenerateIdHook = NonNullable<
  NonNullable<BetterAuthOptions['advanced']>['database']
>['generateId'];

export type DefineAuthBackendOptions = {
  db: DB;
  schema: AuthSchema;
  appName: string;
  appKey: string;
  baseUrl: string;
  productionUrl: string;
  secret: string;

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
    send: (args: { email: string; url: string; token: string }) => Promise<void> | void;
  };

  socialProviders?: {
    google?: Provider;
    apple?: AppleProvider;
    facebook?: Provider;
    microsoft?: Provider & { scope?: string[] };
  };

  enableExpo?: boolean;
  enableEmailAndPassword?: boolean;
  databaseHooks?: BetterAuthOptions['databaseHooks'];
  user?: BetterAuthOptions['user'];
  account?: BetterAuthOptions['account'];
  trustedOrigins?: BetterAuthOptions['trustedOrigins'];
  extraPlugins?: BetterAuthPlugin[];
};

const defaultGenerateId: GenerateIdHook = ({ model }) => {
  const slug = String(model).replace(/s$/, '');
  return `${slug}_${crypto.randomUUID().replace(/-/g, '')}`;
};

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
    databaseHooks,
    user,
    account,
    trustedOrigins,
    extraPlugins = [],
  } = options;

  const cookiePrefix = `auth-${appKey}`;
  const isDevOrTest = process.env['NODE_ENV'] !== 'production';
  const emailAndPasswordEnabled = enableEmailAndPassword ?? isDevOrTest;

  const plugins: BetterAuthPlugin[] = [
    oAuthProxy({ currentURL: baseUrl, productionURL: productionUrl }) as BetterAuthPlugin,
    ...(enableExpo ? [expo() as BetterAuthPlugin] : []),
    ...(magicLinkConfig
      ? [
          magicLink({
            sendMagicLink: async ({ email, url, token }) => {
              await magicLinkConfig.send({ email, url, token });
            },
          }) as BetterAuthPlugin,
        ]
      : []),
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
    ...(emailAndPasswordEnabled && {
      emailAndPassword: {
        enabled: true,
        autoSignIn: true,
        sendResetPassword: async () => {
          authLogger.warn(
            'sendResetPassword called on auto-enabled emailAndPassword (dev/test). Configure enableEmailAndPassword + provide reset handler for production.',
          );
        },
      },
    }),
  });
}

export type DefinedAuth = ReturnType<typeof defineAuthBackend>;
