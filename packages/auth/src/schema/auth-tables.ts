import type {
  AnyPgColumn,
  AnyPgColumnBuilder,
  PgBuildColumns,
  PgSchema,
  PgTableWithColumns,
} from 'drizzle-orm/pg-core';
import { boolean, text, timestamp } from 'drizzle-orm/pg-core';

import type { AuthColumnFill, AuthColumnOptions, PrimaryColumnSource } from './column-options.js';
import { byFill, columnNamer, filledAt, now } from './column-options.js';

export type { AuthColumnFill, AuthColumnNaming, AuthColumnOptions, PrimaryColumnSource } from './column-options.js';

/**
 * Drizzle tables and column sets for the four Better Auth core tables.
 *
 * `createAuthTables(schema, options)` builds all four tables in one call. The
 * app passes its pgSchema, its id columns, who fills the defaulted columns (`fill`),
 * how columns are spelled (`naming`) and its extra or replaced columns
 * (`columns`). The lib never makes ids.
 *
 * Each `auth*Columns(options)` returns a plain record of fresh column builders
 * for apps that must build a table themselves. A key written after the spread
 * replaces that column.
 */

type ColumnMap = Record<string, AnyPgColumnBuilder>;

/**
 * The app's own columns for one table: any key but `id`, which comes from
 * `ids`. Written as a check on the type's own keys, not as `Record<string, …>`:
 * an index signature would make `keyof` of the extras `string` inside the
 * factory, and the standard `id` column would no longer be findable there.
 */
export type ExtraColumns<TColumns> = { [K in keyof TColumns]: K extends 'id' ? never : AnyPgColumnBuilder };

/** No extra columns: what a table gets when `columns` leaves it out. */
type NoColumns = Record<never, never>;

/** Timestamps Better Auth writes itself on insert; `'database'` adds a database default anyway. */
const writtenAt = byFill({
  app: name => timestamp(name).notNull(),
  database: name => timestamp(name).notNull().defaultNow(),
});

/** Verification timestamps: Better Auth's own shape is nullable with a JS default. */
const verificationAt = byFill({
  app: name => timestamp(name).$defaultFn(now),
  database: name => timestamp(name).notNull().defaultNow(),
});

const emailVerified = byFill({
  app: name =>
    boolean(name)
      .notNull()
      .$defaultFn(() => false),
  database: name => boolean(name).notNull().default(false),
});

export type AuthUserOptions<TId extends AnyPgColumnBuilder, TFill extends AuthColumnFill> = AuthColumnOptions<TFill> & {
  /** The primary key column, e.g. `userIdColumns.primaryColumn()`. */
  id: TId;
};

export type AuthSessionOptions<
  TId extends AnyPgColumnBuilder,
  TUserId extends AnyPgColumnBuilder,
  TFill extends AuthColumnFill,
> = AuthColumnOptions<TFill> & {
  /** The primary key column. */
  id: TId;
  /** The column that points at the user, already finished with its `.references(...)`. */
  userId: TUserId;
};

export type AuthAccountOptions<
  TId extends AnyPgColumnBuilder,
  TUserId extends AnyPgColumnBuilder,
  TFill extends AuthColumnFill,
> = AuthSessionOptions<TId, TUserId, TFill>;

export type AuthVerificationOptions<
  TId extends AnyPgColumnBuilder,
  TFill extends AuthColumnFill,
> = AuthColumnOptions<TFill> & {
  /** The primary key column. */
  id: TId;
};

/** Columns of the Better Auth `user` model. */
export function authUserColumns<TId extends AnyPgColumnBuilder, TFill extends AuthColumnFill>({
  id,
  naming,
  fill,
}: AuthUserOptions<TId, TFill>) {
  const name = columnNamer(naming);
  return {
    id,
    name: text(name('name')).notNull(),
    email: text(name('email')).notNull().unique(),
    emailVerified: emailVerified(fill, name('emailVerified')),
    image: text(name('image')),
    createdAt: filledAt(fill, name('createdAt')),
    updatedAt: filledAt(fill, name('updatedAt')),
  };
}

/** Columns of the Better Auth `session` model. */
export function authSessionColumns<
  TId extends AnyPgColumnBuilder,
  TUserId extends AnyPgColumnBuilder,
  TFill extends AuthColumnFill,
>({ id, userId, naming, fill }: AuthSessionOptions<TId, TUserId, TFill>) {
  const name = columnNamer(naming);
  return {
    id,
    expiresAt: timestamp(name('expiresAt')).notNull(),
    token: text(name('token')).notNull().unique(),
    createdAt: writtenAt(fill, name('createdAt')),
    updatedAt: writtenAt(fill, name('updatedAt')),
    ipAddress: text(name('ipAddress')),
    userAgent: text(name('userAgent')),
    userId,
  };
}

/** Columns of the Better Auth `account` model. */
export function authAccountColumns<
  TId extends AnyPgColumnBuilder,
  TUserId extends AnyPgColumnBuilder,
  TFill extends AuthColumnFill,
>({ id, userId, naming, fill }: AuthAccountOptions<TId, TUserId, TFill>) {
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
    createdAt: writtenAt(fill, name('createdAt')),
    updatedAt: writtenAt(fill, name('updatedAt')),
  };
}

/** Columns of the Better Auth `verification` model. */
export function authVerificationColumns<TId extends AnyPgColumnBuilder, TFill extends AuthColumnFill>({
  id,
  naming,
  fill,
}: AuthVerificationOptions<TId, TFill>) {
  const name = columnNamer(naming);
  return {
    id,
    identifier: text(name('identifier')).notNull(),
    value: text(name('value')).notNull(),
    expiresAt: timestamp(name('expiresAt')).notNull(),
    createdAt: verificationAt(fill, name('createdAt')),
    updatedAt: verificationAt(fill, name('updatedAt')),
  };
}

/**
 * The standard columns with the app's own on top. A key in `extra` replaces
 * the standard column. `id` is named on its own so that the factory can read
 * `Table.id` while the extras are still a type parameter.
 */
/**
 * One auth table, typed exactly as `schema.table(name, columns)` returns it. Written out because
 * the compiler's declaration output otherwise loses the table name inside the column types
 * (`tableName: TTableName`), and a select over the published table then reads every column as
 * nullable.
 */
type AuthTable<TName extends string, TColumns extends Record<string, AnyPgColumnBuilder>> = PgTableWithColumns<{
  name: TName;
  schema: string;
  columns: PgBuildColumns<TName, TColumns>;
  dialect: 'pg';
}>;

function authTable<TName extends string, TColumns extends Record<string, AnyPgColumnBuilder>>(
  schema: PgSchema,
  name: TName,
  columns: TColumns,
): AuthTable<TName, TColumns> {
  return schema.table(name, columns);
}

function withColumns<
  TBase extends ColumnMap & { id: AnyPgColumnBuilder },
  TExtra extends ExtraColumns<TExtra> | undefined,
>(base: TBase, extra: TExtra): Pick<TBase, 'id'> & Omit<TBase, keyof NonNullable<TExtra>> & NonNullable<TExtra> {
  return { ...base, ...extra };
}

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
  TFill extends AuthColumnFill,
  TUserColumns extends ExtraColumns<TUserColumns>,
  TSessionColumns extends ExtraColumns<TSessionColumns>,
  TAccountColumns extends ExtraColumns<TAccountColumns>,
  TVerificationColumns extends ExtraColumns<TVerificationColumns>,
> = AuthColumnOptions<TFill> & {
  /** The app's id sources. The lib never makes ids. */
  ids: {
    user: UserIdSource<TUserId, TForeignKeys>;
    session: PrimaryColumnSource<TSessionId>;
    account: PrimaryColumnSource<TAccountId>;
    verification: PrimaryColumnSource<TVerificationId>;
  };
  /**
   * The app's own columns per table, merged after the standard ones: a new key
   * adds a column, a standard key replaces that column. The row types include
   * them.
   */
  columns?: {
    user?: TUserColumns;
    session?: TSessionColumns;
    account?: TAccountColumns;
    verification?: TVerificationColumns;
  };
};

/**
 * The four Better Auth tables. Returns them plus `userForeignKeys`, the factory
 * other features use to point at the user table.
 *
 * @example
 * ```typescript
 * export const { User, Session, Account, Verification, userForeignKeys } = createAuthTables(schema, {
 *   fill: 'app',
 *   ids: {
 *     user: userIdColumns,
 *     session: sessionIdColumns,
 *     account: accountIdColumns,
 *     verification: verificationIdColumns,
 *   },
 *   columns: {
 *     user: { tweaks: tweaksColumn().notNull().default(EMPTY_TWEAKS) },
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
  TFill extends AuthColumnFill,
  TUserColumns extends ExtraColumns<TUserColumns> = NoColumns,
  TSessionColumns extends ExtraColumns<TSessionColumns> = NoColumns,
  TAccountColumns extends ExtraColumns<TAccountColumns> = NoColumns,
  TVerificationColumns extends ExtraColumns<TVerificationColumns> = NoColumns,
>(
  schema: PgSchema,
  {
    ids,
    naming,
    fill,
    columns,
  }: CreateAuthTablesOptions<
    TUserId,
    TSessionId,
    TAccountId,
    TVerificationId,
    TForeignKeys,
    TFill,
    TUserColumns,
    TSessionColumns,
    TAccountColumns,
    TVerificationColumns
  >,
) {
  const name = columnNamer(naming);

  const User = authTable(
    schema,
    'users',
    withColumns(authUserColumns({ id: ids.user.primaryColumn(), naming, fill }), columns?.user),
  );

  const userForeignKeys = ids.user.createForeignKeyFactory(() => User.id);

  const userReference = () =>
    text(name('userId'))
      .notNull()
      .$type<typeof User.id._.data>()
      .references(() => User.id, { onDelete: 'cascade' });

  const Account = authTable(
    schema,
    'accounts',
    withColumns(
      authAccountColumns({ id: ids.account.primaryColumn(), userId: userReference(), naming, fill }),
      columns?.account,
    ),
  );

  const Session = authTable(
    schema,
    'sessions',
    withColumns(
      authSessionColumns({ id: ids.session.primaryColumn(), userId: userReference(), naming, fill }),
      columns?.session,
    ),
  );

  const Verification = authTable(
    schema,
    'verifications',
    withColumns(authVerificationColumns({ id: ids.verification.primaryColumn(), naming, fill }), columns?.verification),
  );

  return { User, Session, Account, Verification, userForeignKeys };
}
