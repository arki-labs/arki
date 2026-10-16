/**
 * The server-side contract of `@arki/auth/pg`: what the app binds at boot and what it gets back.
 */
import type { BetterAuthPlugin } from 'better-auth';
import type { AnyRelations } from 'drizzle-orm';
import type { AnyPgTable, PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import type { KV } from '@arki/kv';
import type { Mailer, MailTemplate } from '@arki/mail';
import type { magicLink } from '@arki/mail/templates/auth';

import type { AuthDefinition, AuthMethod, ExposedFields, SocialMethod, SocialMethodsOf } from '../definition.js';
import type { Principal, PrincipalTables, PrincipalVia, SessionIdOf, UserRow } from '../principal.js';

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

/** The link mails. Each takes the `@arki/mail/templates/auth` link input. */
export type AuthLinkTemplate = MailTemplate<(typeof magicLink)['input']>;
export type AuthTemplates = {
  readonly magicLink: AuthLinkTemplate;
  readonly verifyEmail: AuthLinkTemplate;
  readonly resetPassword: AuthLinkTemplate;
};

/** The rate-limit store: an `@arki/kv` instance, shared by every replica. */
export type RateLimitStore = Pick<KV, 'getRateLimiter'>;

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

export type AuthBindings<D extends AuthDefinition, T extends AuthTables> = {
  readonly db: AuthDb;
  readonly tables: T & TablesExposing<D>;
  /** Read once, at boot. */
  readonly runtime: () => AuthRuntime<D>;
  /** Required when a method sends mail (password, magic link) → `ARKI_AUTH_E003` at boot. */
  readonly mail?: Pick<Mailer, 'send'>;
  /** Replace the default `@arki/mail/templates/auth` mails. */
  readonly templates?: Partial<AuthTemplates>;
  /** Required in production. `false` turns rate limiting off, outside production only. */
  readonly rateLimit?: { readonly store: RateLimitStore } | false;
  /** The principal's roles. A throwing resolver fails the request; it never makes a guest. */
  readonly roles?: (user: UserRow<D, T>) => readonly string[] | Promise<readonly string[]>;
  readonly on?: AuthEvents<PrincipalFor<D, T>, UserRow<D, T>>;
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
