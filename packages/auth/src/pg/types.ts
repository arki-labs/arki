/**
 * The server-side contract of `@arki/auth/pg`: what the app binds at boot and what it gets back.
 */
import type { BetterAuthPlugin } from 'better-auth';
import type { AnyRelations, InferInsertModel } from 'drizzle-orm';
import type { AnyPgTable, PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import type { KV } from '@arki/kv';
import type { Mailer, MailTemplate } from '@arki/mail';
import type { AuthLinkData, AuthLinkInput, magicLink } from '@arki/mail/templates/auth';

import type { AuthDefinition, AuthMethod, ExposedFields, SocialMethod, SocialMethodsOf } from '../definition.js';
import type {
  Principal,
  PrincipalSession,
  PrincipalTables,
  PrincipalVia,
  SessionIdOf,
  UserIdOf,
  UserRow,
} from '../principal.js';

/**
 * A Drizzle Postgres database: node-postgres, PGlite, or any other async Postgres driver.
 * The engine's adapter only needs the query builder every one of them shares.
 */
export type AuthDb = PgAsyncDatabase<PgQueryResultHKT, AnyRelations>;

/**
 * The app's auth tables, usually from `createAuthTables` (and `createWorkspaceTables` when the
 * definition turns `workspaces` on). Row types are read from them: the principal's `user.id` is
 * the table's branded id.
 */
export type AuthTables = PrincipalTables & {
  readonly User: AnyPgTable;
  readonly Session: AnyPgTable;
  readonly Account: AnyPgTable;
  readonly Verification: AnyPgTable;
  readonly Organization?: AnyPgTable;
  readonly Member?: AnyPgTable;
  readonly Invitation?: AnyPgTable;
  readonly Team?: AnyPgTable;
  readonly TeamMember?: AnyPgTable;
};

/** A user table whose row has every column the definition exposes. Unknown names do not compile. */
export type TablesExposing<D> = {
  readonly User: { readonly $inferSelect: Readonly<Record<ExposedFields<D>, unknown>> };
};

type ClientCredentials = {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Extra OAuth scopes on top of the provider's defaults. */
  readonly scope?: readonly string[];
};

/** Credentials per social provider. */
export type ProviderCredentialsMap = {
  readonly google: ClientCredentials;
  readonly apple: ClientCredentials & { readonly appBundleIdentifier?: string };
  readonly facebook: ClientCredentials;
  readonly microsoft: ClientCredentials & { readonly tenantId?: string };
  readonly github: ClientCredentials;
};
export type ProviderCredentials<K extends SocialMethod> = ProviderCredentialsMap[K];

/**
 * Disabled providers are typed `never`, not just left out: a key for one is refused even where
 * TypeScript skips excess-property checks (an object returned from the `runtime` arrow function).
 */
type DisabledProviders<D> = Readonly<Partial<Record<Exclude<SocialMethod, SocialMethodsOf<D>>, never>>>;

/** `providers` holds exactly the enabled social methods; without any, it may be left out. */
type ProvidersFor<D> = [SocialMethodsOf<D>] extends [never]
  ? { readonly providers?: DisabledProviders<D> }
  : {
      readonly providers: { readonly [K in SocialMethodsOf<D>]: ProviderCredentials<K> } & DisabledProviders<D>;
    };

/** Values read at boot (from env), never at import. */
export type AuthRuntime<D> = {
  /** The URL this backend answers on. */
  readonly url: string;
  /** The deployed URL, when OAuth callbacks must go through it (`oAuthProxy`). */
  readonly productionUrl?: string;
  /** Signs cookies and tokens. At least 32 characters when `production`. */
  readonly secret: string | undefined;
  readonly production: boolean;
  readonly trustedOrigins?: readonly string[];
  /** The one header the ingress sets to the client address. Others, like a spoofed `x-forwarded-for`, are ignored. */
  readonly clientIp?: { readonly header: string };
} & ProvidersFor<D>;

/** The input of an auth link mail: the `@arki/mail/templates/auth` link input, plus the brand's site. */
export type AuthLinkMailInput = AuthLinkInput & { readonly appUrl?: string };
/** What an auth link template renders from. `appUrl` is the picked brand's site, when the picker named one. */
export type AuthLinkMailData = AuthLinkData & { readonly appUrl?: string };

/** A failed validation, in the shape the `@arki/mail` link input reports it. */
type AuthLinkMailIssues = Extract<
  Awaited<ReturnType<(typeof magicLink)['input']['~standard']['validate']>>,
  { readonly issues: unknown }
>;

/**
 * A Standard Schema for {@link AuthLinkMailInput}. `authLinkInput` is the one this package ships:
 * the `@arki/mail` link rules, plus an optional http(s) `appUrl`. The default templates' schema
 * fits this type too; it just drops `appUrl`.
 */
export type AuthLinkInputSchema = {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | AuthLinkMailIssues
      | { readonly value: AuthLinkMailData; readonly issues?: undefined }
      | Promise<AuthLinkMailIssues | { readonly value: AuthLinkMailData; readonly issues?: undefined }>;
    readonly types?: { readonly input: AuthLinkMailInput; readonly output: AuthLinkMailData } | undefined;
  };
};

/**
 * The link mails. The `@arki/mail/templates/auth` templates fit as they are. A custom template that
 * also wants the brand's site declares `input: authLinkInput` and reads `data.appUrl`.
 */
export type AuthLinkTemplate = MailTemplate<AuthLinkInputSchema>;
export type AuthTemplates = {
  readonly magicLink: AuthLinkTemplate;
  readonly verifyEmail: AuthLinkTemplate;
  readonly resetPassword: AuthLinkTemplate;
};

/** The rate-limit store: an `@arki/kv` instance, shared by every replica. */
export type RateLimitStore = Pick<KV, 'getRateLimiter'>;

/**
 * Where the rate limiter counts: an `@arki/kv` store shared by every replica, or `'memory'`, the
 * engine's own limiter, which counts per process (each replica has its own budget).
 */
export type RateLimitBinding = { readonly store: RateLimitStore | 'memory' };

/**
 * The brand on one auth mail. A field left out keeps the default: the app's name, the mailer's sender.
 * `appUrl`, the brand's site, reaches only custom `templates` that declare `input: authLinkInput`.
 */
export type AuthMailBrand = { readonly appName?: string; readonly from?: string; readonly appUrl?: string };

/**
 * Picks the brand of each auth mail from the request that asked for it, so one backend can send
 * for several brands. `request` is absent when the engine sends without one.
 */
export type AuthMailBrandPicker = (event: { readonly request?: Request }) => AuthMailBrand | Promise<AuthMailBrand>;

/** Session columns the engine writes itself. `sessionCreating` cannot set them. */
export const ENGINE_SESSION_COLUMNS = [
  'id',
  'token',
  'userId',
  'expiresAt',
  'createdAt',
  'updatedAt',
  'ipAddress',
  'userAgent',
] as const;
export type EngineSessionColumn = (typeof ENGINE_SESSION_COLUMNS)[number];

type SessionInsert<T extends AuthTables> = InferInsertModel<T['Session']>;

/** The app's own session columns (from `createAuthTables(..., { columns: { session } })`), as `sessionCreating` returns them. */
export type SessionValues<T extends AuthTables> = {
  readonly [K in Exclude<keyof SessionInsert<T>, EngineSessionColumn>]?: SessionInsert<T>[K];
};

/**
 * `S` with every key the session table lacks typed `never`: an unknown column name does not
 * compile. When `S` has no such key it stays as it is, so a return with only unknown keys (where
 * inference falls back to `V`) still meets `V`'s own check.
 */
export type OnlySessionColumns<S, V> = [Exclude<keyof S, keyof V>] extends [never]
  ? S
  : S & Readonly<Record<Exclude<keyof S, keyof V>, never>>;

/**
 * The session hooks. `sessionCreating` runs before every session the engine writes (every sign-in
 * path, `actingAs` included) and returns values for the app's own session columns; it may return
 * nothing. A thrown `AuthError` refuses the session (403 with the error's code). `sessionCreated`
 * observes each new session; a throwing observer is logged and the response stays.
 */
export type SessionEvents<UId extends string, SId extends string, S> = {
  readonly sessionCreating?: (event: {
    readonly userId: UId;
    readonly request?: Request;
  }) => S | void | Promise<S | void>;
  readonly sessionCreated?: (event: {
    readonly userId: UId;
    readonly session: PrincipalSession<SId>;
  }) => void | Promise<void>;
};

/** Why a sign-in failed. Never the email, never the body. */
export type SignInFailure = 'credentials' | 'unverified' | 'rateLimited' | 'unknown';

/**
 * Plain functions called after the fact. They never change the response; a throwing observer is
 * logged. Only `beforeUserCreate` can refuse, by throwing an `AuthError`. Events never carry
 * tokens, cookies, headers or bodies.
 */
export type AuthEvents<P, U> = {
  readonly beforeUserCreate?: (event: {
    readonly email: string;
    readonly method: AuthMethod;
    readonly request?: Request;
  }) => void | Promise<void>;
  readonly userCreated?: (event: { readonly user: U; readonly method: AuthMethod }) => void | Promise<void>;
  readonly signIn?: (event: {
    readonly principal: P;
    readonly method: AuthMethod;
    readonly requestId: string;
  }) => void | Promise<void>;
  readonly signInFailed?: (event: {
    readonly method: AuthMethod;
    readonly reason: SignInFailure;
    readonly requestId: string;
  }) => void | Promise<void>;
  readonly passwordChanged?: (event: {
    readonly userId: string;
    readonly reason: 'change' | 'reset';
  }) => void | Promise<void>;
  readonly signOut?: (event: { readonly principal: P }) => void | Promise<void>;
};

/** The principal an auth built from `D` and `T` produces. */
export type PrincipalFor<D, T extends PrincipalTables> = Principal<UserRow<D, T>, SessionIdOf<T>>;

/**
 * Everything `on` takes: the auth events and the session hooks. `S` is what `sessionCreating`
 * returns, inferred, so a column the session table lacks does not compile.
 */
export type AuthBindingEvents<D, T extends AuthTables, S> = AuthEvents<PrincipalFor<D, T>, UserRow<D, T>> &
  SessionEvents<UserIdOf<T>, SessionIdOf<T>, S>;

export type AuthBindings<
  D extends AuthDefinition,
  T extends AuthTables,
  S extends SessionValues<T> = SessionValues<T>,
> = {
  readonly db: AuthDb;
  readonly tables: T & TablesExposing<D>;
  /** Read once, at boot. */
  readonly runtime: () => AuthRuntime<D>;
  /** Required when a method sends mail (password, magic link) → `ARKI_AUTH_E003` at boot. */
  readonly mail?: Pick<Mailer, 'send'>;
  /** Replace the default `@arki/mail/templates/auth` mails. */
  readonly templates?: Partial<AuthTemplates>;
  /** The brand (`appName`, `from`) of each auth mail, picked per request. Default: the app's name and the mailer's sender. */
  readonly mailBrand?: AuthMailBrandPicker;
  /**
   * Required in production: `{ store: kv }` (shared by every replica) or `{ store: 'memory' }`
   * (per process, logged as a warning at boot). `false` turns rate limiting off, outside production only.
   */
  readonly rateLimit?: RateLimitBinding | false;
  /** The principal's roles. A throwing resolver fails the request; it never makes a guest. */
  readonly roles?: (user: UserRow<D, T>) => readonly string[] | Promise<readonly string[]>;
  readonly on?: AuthBindingEvents<D, T, OnlySessionColumns<S, SessionValues<T>>>;
  /** Escape hatch: `tanstackStart()`, app plugins. */
  readonly plugins?: readonly BetterAuthPlugin[];
};

/** One of the caller's sessions. Never the token. */
export type SessionSummary<SId extends string = string> = {
  readonly id: SId;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** The session the principal came with. */
  readonly current: boolean;
};

export type AuthSessions<P, SId extends string, UId extends string> = {
  /** The principal's own sessions. */
  list(principal: P): Promise<readonly SessionSummary<SId>[]>;
  /** Revokes one of the principal's own sessions. Someone else's id does nothing. */
  revoke(principal: P, id: SId): Promise<void>;
  /** Revokes every session of the principal but the current one. */
  revokeOthers(principal: P): Promise<void>;
  /** Revokes every session of a user. A trusted server call: no principal is checked. */
  revokeUser(userId: UId): Promise<void>;
};

/** A test user: the email, and any of the row's other columns. */
export type TestUserInput<U> = { readonly email: string; readonly name?: string } & Partial<Omit<U, 'id' | 'email'>>;

export type TestSignInOptions = { readonly via?: PrincipalVia; readonly password?: string };

/** Test-only session minting. Every call throws `ARKI_AUTH_E005` when `production`. */
export type AuthTestingApi<U> = {
  /**
   * Creates (or finds) the user and a real session; returns headers that carry it. With
   * `password` (needs the `password` method) the user's password is set to it, so the same user
   * can also sign in through the form.
   */
  signIn(user: TestUserInput<U>, options?: TestSignInOptions): Promise<{ readonly headers: Headers; readonly user: U }>;
};

export type { PrincipalTables, UserIdOf } from '../principal.js';
