import type { Column } from 'drizzle-orm';

import type { AnyColumnSpec, ColumnKit, Dialect } from '@arki/db/columns';

import type {
  AuthColumnFill,
  AuthColumnOptions,
  ColumnSpecs,
  PrimaryColumnSource,
  SpecValue,
} from './column-options.js';
import { byFill, columnNamer, filledAt, now } from './column-options.js';

export type { AuthColumnFill, AuthColumnNaming, AuthColumnOptions, PrimaryColumnSource } from './column-options.js';

/**
 * Drizzle tables and column sets for the four Better Auth core tables, written
 * once against the column kit (`@arki/db/columns`): `pgColumns(schema)` builds
 * them on Postgres, `sqliteColumns({ prefix })` on SQLite.
 *
 * `createAuthTables(c, options)` builds all four tables in one call. The app
 * passes its kit, its id columns, who fills the defaulted columns (`fill`), how
 * columns are spelled (`naming`) and its extra or replaced columns (`columns`).
 * The lib never makes ids.
 *
 * Each `auth*Columns(c, options)` returns a plain record of fresh column specs
 * for apps that must build a table themselves (`c.table(name, columns)`). A key
 * written after the spread replaces that column.
 */

/**
 * The app's own columns for one table: any key but `id`, which comes from
 * `ids`. Written as a check on the type's own keys, not as `Record<string, …>`:
 * an index signature would make `keyof` of the extras `string` inside the
 * factory, and the standard `id` column would no longer be findable there.
 */
export type ExtraColumns<D extends Dialect, TColumns> = {
  [K in keyof TColumns]: K extends 'id' ? never : AnyColumnSpec<D>;
};

/** No extra columns: what a table gets when `columns` leaves it out. */
type NoColumns = Record<never, never>;

/** The fill-aware column makers of one kit. */
function authColumnMakers<D extends Dialect>(c: ColumnKit<D>) {
  return {
    filledAt: filledAt(c),
    /** Timestamps Better Auth writes itself on insert; `'database'` adds a database default anyway. */
    writtenAt: byFill({
      app: name => c.timestamp(name).notNull(),
      database: name => c.timestamp(name).notNull().defaultNow(),
    }),
    /** Verification timestamps: Better Auth's own shape is nullable with a JS default. */
    verificationAt: byFill({
      app: name => c.timestamp(name).$defaultFn(now),
      database: name => c.timestamp(name).notNull().defaultNow(),
    }),
    emailVerified: byFill({
      app: name =>
        c
          .boolean(name)
          .notNull()
          .$defaultFn(() => false),
      database: name => c.boolean(name).notNull().default(false),
    }),
  };
}

export type AuthUserOptions<TId, TFill extends AuthColumnFill> = AuthColumnOptions<TFill> & {
  /** The primary key column, e.g. `c.id(userId).primaryColumn()`. */
  id: TId;
};

export type AuthSessionOptions<TId, TUserId, TFill extends AuthColumnFill> = AuthColumnOptions<TFill> & {
  /** The primary key column. */
  id: TId;
  /** The column that points at the user, already finished with its `.references(...)`. */
  userId: TUserId;
};

export type AuthAccountOptions<TId, TUserId, TFill extends AuthColumnFill> = AuthSessionOptions<TId, TUserId, TFill>;

export type AuthVerificationOptions<TId, TFill extends AuthColumnFill> = AuthColumnOptions<TFill> & {
  /** The primary key column. */
  id: TId;
};

/** Columns of the Better Auth `user` model. */
export function authUserColumns<D extends Dialect, TId extends AnyColumnSpec<D>, TFill extends AuthColumnFill>(
  c: ColumnKit<D>,
  { id, naming, fill }: AuthUserOptions<TId, TFill>,
) {
  const name = columnNamer(naming);
  const make = authColumnMakers(c);
  return {
    id,
    name: c.text(name('name')).notNull(),
    email: c.text(name('email')).notNull().unique(),
    emailVerified: make.emailVerified(fill, name('emailVerified')),
    image: c.text(name('image')),
    createdAt: make.filledAt(fill, name('createdAt')),
    updatedAt: make.filledAt(fill, name('updatedAt')),
  };
}

/** Columns of the Better Auth `session` model. */
export function authSessionColumns<
  D extends Dialect,
  TId extends AnyColumnSpec<D>,
  TUserId extends AnyColumnSpec<D>,
  TFill extends AuthColumnFill,
>(c: ColumnKit<D>, { id, userId, naming, fill }: AuthSessionOptions<TId, TUserId, TFill>) {
  const name = columnNamer(naming);
  const make = authColumnMakers(c);
  return {
    id,
    expiresAt: c.timestamp(name('expiresAt')).notNull(),
    token: c.text(name('token')).notNull().unique(),
    createdAt: make.writtenAt(fill, name('createdAt')),
    updatedAt: make.writtenAt(fill, name('updatedAt')),
    ipAddress: c.text(name('ipAddress')),
    userAgent: c.text(name('userAgent')),
    userId,
  };
}

/** Columns of the Better Auth `account` model. */
export function authAccountColumns<
  D extends Dialect,
  TId extends AnyColumnSpec<D>,
  TUserId extends AnyColumnSpec<D>,
  TFill extends AuthColumnFill,
>(c: ColumnKit<D>, { id, userId, naming, fill }: AuthAccountOptions<TId, TUserId, TFill>) {
  const name = columnNamer(naming);
  const make = authColumnMakers(c);
  return {
    id,
    accountId: c.text(name('accountId')).notNull(),
    providerId: c.text(name('providerId')).notNull(),
    userId,
    accessToken: c.text(name('accessToken')),
    refreshToken: c.text(name('refreshToken')),
    idToken: c.text(name('idToken')),
    accessTokenExpiresAt: c.timestamp(name('accessTokenExpiresAt')),
    refreshTokenExpiresAt: c.timestamp(name('refreshTokenExpiresAt')),
    scope: c.text(name('scope')),
    password: c.text(name('password')),
    createdAt: make.writtenAt(fill, name('createdAt')),
    updatedAt: make.writtenAt(fill, name('updatedAt')),
  };
}

/** Columns of the Better Auth `verification` model. */
export function authVerificationColumns<D extends Dialect, TId extends AnyColumnSpec<D>, TFill extends AuthColumnFill>(
  c: ColumnKit<D>,
  { id, naming, fill }: AuthVerificationOptions<TId, TFill>,
) {
  const name = columnNamer(naming);
  const make = authColumnMakers(c);
  return {
    id,
    identifier: c.text(name('identifier')).notNull(),
    value: c.text(name('value')).notNull(),
    expiresAt: c.timestamp(name('expiresAt')).notNull(),
    createdAt: make.verificationAt(fill, name('createdAt')),
    updatedAt: make.verificationAt(fill, name('updatedAt')),
  };
}

/**
 * The standard columns with the app's own on top. A key in `extra` replaces
 * the standard column. `id` is named on its own so that the factory can read
 * `Table.id` while the extras are still a type parameter.
 */
function withColumns<
  D extends Dialect,
  TBase extends ColumnSpecs<D> & { id: AnyColumnSpec<D> },
  TExtra extends ExtraColumns<D, TExtra> | undefined,
>(base: TBase, extra: TExtra): Pick<TBase, 'id'> & Omit<TBase, keyof NonNullable<TExtra>> & NonNullable<TExtra> {
  return { ...base, ...extra };
}

/**
 * The user id source also makes foreign keys that point at the user table.
 * `createForeignKeyFactory` is a method, so a dialect's own factory (taking
 * `() => PgColumn` or `() => SQLiteColumn`) fits where the user table's `id` is
 * typed as a plain `Column`; a factory of the other dialect still does not.
 */
export type UserIdSource<TSpec, TForeignKeys> = PrimaryColumnSource<TSpec> & {
  createForeignKeyFactory(reference: () => Column): TForeignKeys;
};

export type CreateAuthTablesOptions<
  D extends Dialect,
  TUserId extends AnyColumnSpec<D>,
  TSessionId extends AnyColumnSpec<D>,
  TAccountId extends AnyColumnSpec<D>,
  TVerificationId extends AnyColumnSpec<D>,
  TForeignKeys,
  TFill extends AuthColumnFill,
  TUserColumns extends ExtraColumns<D, TUserColumns>,
  TSessionColumns extends ExtraColumns<D, TSessionColumns>,
  TAccountColumns extends ExtraColumns<D, TAccountColumns>,
  TVerificationColumns extends ExtraColumns<D, TVerificationColumns>,
> = AuthColumnOptions<TFill> & {
  /** The app's id sources, e.g. `authIdSources` from `@arki/auth/pg`. The lib never makes ids. */
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
 * const c = pgColumns(schema);
 * export const { User, Session, Account, Verification, userForeignKeys } = createAuthTables(c, {
 *   fill: 'app',
 *   ids: authIdSources,
 *   columns: {
 *     user: { tweaks: tweaksSpec(c).notNull().default(EMPTY_TWEAKS) },
 *   },
 * });
 * ```
 */
export function createAuthTables<
  D extends Dialect,
  TUserId extends AnyColumnSpec<D>,
  TSessionId extends AnyColumnSpec<D>,
  TAccountId extends AnyColumnSpec<D>,
  TVerificationId extends AnyColumnSpec<D>,
  TForeignKeys,
  TFill extends AuthColumnFill,
  TUserColumns extends ExtraColumns<D, TUserColumns> = NoColumns,
  TSessionColumns extends ExtraColumns<D, TSessionColumns> = NoColumns,
  TAccountColumns extends ExtraColumns<D, TAccountColumns> = NoColumns,
  TVerificationColumns extends ExtraColumns<D, TVerificationColumns> = NoColumns,
>(
  c: ColumnKit<D>,
  {
    ids,
    naming,
    fill,
    columns,
  }: CreateAuthTablesOptions<
    D,
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

  const User = c.table(
    'users',
    withColumns(authUserColumns(c, { id: ids.user.primaryColumn(), naming, fill }), columns?.user),
  );

  const userForeignKeys = ids.user.createForeignKeyFactory(() => User.id);

  const userReference = () =>
    c
      .text(name('userId'))
      .notNull()
      .$type<SpecValue<TUserId>>()
      .references(() => User.id, { onDelete: 'cascade' });

  const Account = c.table(
    'accounts',
    withColumns(
      authAccountColumns(c, { id: ids.account.primaryColumn(), userId: userReference(), naming, fill }),
      columns?.account,
    ),
  );

  const Session = c.table(
    'sessions',
    withColumns(
      authSessionColumns(c, { id: ids.session.primaryColumn(), userId: userReference(), naming, fill }),
      columns?.session,
    ),
  );

  const Verification = c.table(
    'verifications',
    withColumns(
      authVerificationColumns(c, { id: ids.verification.primaryColumn(), naming, fill }),
      columns?.verification,
    ),
  );

  return { User, Session, Account, Verification, userForeignKeys };
}
