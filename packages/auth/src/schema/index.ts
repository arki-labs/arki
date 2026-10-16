import type { AnyPgColumn, AnyPgColumnBuilder, PgSchema } from 'drizzle-orm/pg-core';
import { boolean, text, timestamp } from 'drizzle-orm/pg-core';

import { EMPTY_TWEAKS, tweaksColumn } from '../tweaks-column';

/**
 * Drizzle column sets for the four Better Auth core tables.
 *
 * Each `auth*Columns(options)` returns a plain record of fresh column builders.
 * An app spreads it into its own `schema.table(...)`. A key written after the
 * spread replaces that column, which is how an app says "mine differs here".
 * The lib never makes ids: the app passes its own id (and user foreign key)
 * column builders.
 *
 * @example
 * ```typescript
 * export const User = schema.table('users', {
 *   ...authUserColumns({ id: userIdFactory.primaryColumn() }),
 *   // override: this app keeps a database default for the flag
 *   emailVerified: boolean('email_verified').notNull().default(false),
 *   // extra column
 *   accessGrantedAt: timestamp('access_granted_at'),
 * });
 * ```
 */

/** How column names are spelled in the database: `email_verified` or `emailVerified`. */
export type AuthColumnNaming = 'snake' | 'camel';

type NamingOption = {
  /** Spelling of the database column names. Default: `'snake'`. */
  naming?: AuthColumnNaming;
};

type ColumnNamer = (key: string) => string;

const toSnakeCase: ColumnNamer = key => key.replaceAll(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
const keepKey: ColumnNamer = key => key;

function columnNamer(naming: AuthColumnNaming = 'snake'): ColumnNamer {
  return naming === 'camel' ? keepKey : toSnakeCase;
}

const now = () => /* @__PURE__ */ new Date();

export type AuthUserOptions<TId extends AnyPgColumnBuilder> = NamingOption & {
  /** The primary key column, e.g. `userIdFactory.primaryColumn()`. */
  id: TId;
};

export type AuthSessionOptions<TId extends AnyPgColumnBuilder, TUserId extends AnyPgColumnBuilder> = NamingOption & {
  /** The primary key column. */
  id: TId;
  /** The column that points at the user, already finished with its `.references(...)`. */
  userId: TUserId;
};

export type AuthAccountOptions<TId extends AnyPgColumnBuilder, TUserId extends AnyPgColumnBuilder> = AuthSessionOptions<
  TId,
  TUserId
>;

export type AuthVerificationOptions<TId extends AnyPgColumnBuilder> = NamingOption & {
  /** The primary key column. */
  id: TId;
};

/** Columns of the Better Auth `user` model. */
export function authUserColumns<TId extends AnyPgColumnBuilder>({ id, naming }: AuthUserOptions<TId>) {
  const name = columnNamer(naming);
  return {
    id,
    name: text(name('name')).notNull(),
    email: text(name('email')).notNull().unique(),
    emailVerified: boolean(name('emailVerified'))
      .$defaultFn(() => false)
      .notNull(),
    image: text(name('image')),
    createdAt: timestamp(name('createdAt')).$defaultFn(now).notNull(),
    updatedAt: timestamp(name('updatedAt')).$defaultFn(now).notNull(),
  };
}

/** Columns of the Better Auth `session` model. */
export function authSessionColumns<TId extends AnyPgColumnBuilder, TUserId extends AnyPgColumnBuilder>({
  id,
  userId,
  naming,
}: AuthSessionOptions<TId, TUserId>) {
  const name = columnNamer(naming);
  return {
    id,
    expiresAt: timestamp(name('expiresAt')).notNull(),
    token: text(name('token')).notNull().unique(),
    createdAt: timestamp(name('createdAt')).notNull(),
    updatedAt: timestamp(name('updatedAt')).notNull(),
    ipAddress: text(name('ipAddress')),
    userAgent: text(name('userAgent')),
    userId,
  };
}

/** Columns of the Better Auth `account` model. */
export function authAccountColumns<TId extends AnyPgColumnBuilder, TUserId extends AnyPgColumnBuilder>({
  id,
  userId,
  naming,
}: AuthAccountOptions<TId, TUserId>) {
  const name = columnNamer(naming);
  return {
    id,
    accountId: text(name('accountId')).notNull(),
    providerId: text(name('providerId')).notNull(),
    userId,
    accessToken: text(name('accessToken')),
    refreshToken: text(name('refreshToken')),
    idToken: text(name('idToken')),
    accessTokenExpiresAt: timestamp(name('accessTokenExpiresAt')),
    refreshTokenExpiresAt: timestamp(name('refreshTokenExpiresAt')),
    scope: text(name('scope')),
    password: text(name('password')),
    createdAt: timestamp(name('createdAt')).notNull(),
    updatedAt: timestamp(name('updatedAt')).notNull(),
  };
}

/** Columns of the Better Auth `verification` model. */
export function authVerificationColumns<TId extends AnyPgColumnBuilder>({ id, naming }: AuthVerificationOptions<TId>) {
  const name = columnNamer(naming);
  return {
    id,
    identifier: text(name('identifier')).notNull(),
    value: text(name('value')).notNull(),
    expiresAt: timestamp(name('expiresAt')).notNull(),
    createdAt: timestamp(name('createdAt')).$defaultFn(now),
    updatedAt: timestamp(name('updatedAt')).$defaultFn(now),
  };
}

/** Something that makes the primary key column of one table. */
type PrimaryColumnSource<TBuilder extends AnyPgColumnBuilder> = {
  primaryColumn: () => TBuilder;
};

/** The user id source also makes foreign keys that point at the user table. */
type UserIdSource<TBuilder extends AnyPgColumnBuilder, TForeignKeys> = PrimaryColumnSource<TBuilder> & {
  createForeignKeyFactory: (reference: () => AnyPgColumn) => TForeignKeys;
};

export type CreateAuthTablesOptions<
  TUserId extends AnyPgColumnBuilder,
  TSessionId extends AnyPgColumnBuilder,
  TAccountId extends AnyPgColumnBuilder,
  TVerificationId extends AnyPgColumnBuilder,
  TForeignKeys,
> = NamingOption & {
  /** The app's id sources. The lib never makes ids. */
  ids: {
    user: UserIdSource<TUserId, TForeignKeys>;
    session: PrimaryColumnSource<TSessionId>;
    account: PrimaryColumnSource<TAccountId>;
    verification: PrimaryColumnSource<TVerificationId>;
  };
};

/**
 * The four auth tables with the standard shape, for a new app. Use the column
 * sets directly when an app must keep a different shape.
 *
 * Returns the tables plus `userForeignKeys`, the factory other features use to
 * point at the user table.
 *
 * @example
 * ```typescript
 * export const { User, Session, Account, Verification, userForeignKeys } = createAuthTables(schema, {
 *   ids: {
 *     user: userIdFactory,
 *     session: sessionIdFactory,
 *     account: accountIdFactory,
 *     verification: verificationIdFactory,
 *   },
 * });
 * ```
 */
export function createAuthTables<
  TUserId extends AnyPgColumnBuilder,
  TSessionId extends AnyPgColumnBuilder,
  TAccountId extends AnyPgColumnBuilder,
  TVerificationId extends AnyPgColumnBuilder,
  TForeignKeys,
>(
  schema: PgSchema,
  { ids, naming }: CreateAuthTablesOptions<TUserId, TSessionId, TAccountId, TVerificationId, TForeignKeys>,
) {
  const name = columnNamer(naming);

  const User = schema.table('users', {
    ...authUserColumns({ id: ids.user.primaryColumn(), naming }),
    tweaks: tweaksColumn().notNull().default(EMPTY_TWEAKS),
  });

  const userForeignKeys = ids.user.createForeignKeyFactory(() => User.id);

  const userReference = () =>
    text(name('userId'))
      .notNull()
      .$type<typeof User.$inferSelect.id>()
      .references(() => User.id, { onDelete: 'cascade' });

  const Account = schema.table(
    'accounts',
    authAccountColumns({ id: ids.account.primaryColumn(), userId: userReference(), naming }),
  );

  const Session = schema.table(
    'sessions',
    authSessionColumns({ id: ids.session.primaryColumn(), userId: userReference(), naming }),
  );

  const Verification = schema.table(
    'verifications',
    authVerificationColumns({ id: ids.verification.primaryColumn(), naming }),
  );

  return { User, Session, Account, Verification, userForeignKeys };
}
