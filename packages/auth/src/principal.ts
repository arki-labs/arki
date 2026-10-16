/**
 * The principal: the one "who is calling" value that oRPC guards, `@arki/http` derivers and
 * policies read. `null` means a guest. Its `user` is the app's own user row type (branded id),
 * narrowed to the core columns plus the extra columns the definition exposes.
 *
 * This module is pure: types and one narrowing function, no engine and no database code.
 */
import type { ExposedFields } from './definition.js';
import { AUTH_ERROR_CODES, AuthError } from './errors.js';

/** The user columns the engine owns, as the principal sees them. */
export const CORE_USER_KEYS = ['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt'] as const;
export type CoreUserKey = (typeof CORE_USER_KEYS)[number];

/** The shape every auth user table's row has. The app's table may brand `id` and add columns. */
export type CoreUserRow = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly image: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** Anything with a user table and a session table whose rows the principal is built from. */
export type PrincipalTables = {
  readonly User: { readonly $inferSelect: CoreUserRow };
  readonly Session: { readonly $inferSelect: { readonly id: string } };
};

/** The app's user id type, read from its user table. */
export type UserIdOf<T extends PrincipalTables> = T['User']['$inferSelect']['id'];

/** The app's session id type, read from its session table. */
export type SessionIdOf<T extends PrincipalTables> = T['Session']['$inferSelect']['id'];

/** The principal's user: the core columns plus the exposed ones, with the table's own types. */
export type UserRow<D, T extends PrincipalTables> = Pick<
  T['User']['$inferSelect'],
  CoreUserKey | (ExposedFields<D> & keyof T['User']['$inferSelect'])
>;

export type PrincipalSession<SId extends string = string> = {
  readonly id: SId;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
};

/** How the request proved its session. */
export type PrincipalVia = 'cookie' | 'bearer';

export type Principal<U, SId extends string = string> = {
  readonly user: U;
  readonly session: PrincipalSession<SId>;
  readonly via: PrincipalVia;
  readonly roles: readonly string[];
  /** The selected workspace. A selection, not proof of membership: check membership where it matters. */
  readonly workspace?: { readonly activeOrganizationId: string | null; readonly activeTeamId: string | null };
};

/** The least every principal carries. Guards accept any principal through this type. */
export type AnyPrincipal = Principal<{ readonly id: string; readonly emailVerified: boolean }>;

/** The principal type an auth produces: `PrincipalOf<typeof auth>`. */
export type PrincipalOf<A> = A extends { readonly principal: (headers: Headers) => Promise<infer P | null> }
  ? P
  : never;

/** A request context that carries the principal, or `null` for a guest. */
export type AuthContext<A> = { readonly principal: PrincipalOf<A> | null };

const shapeError = (message: string) =>
  new AuthError(AUTH_ERROR_CODES.principalShape, `[@arki/auth] The engine's ${message}.`);

const isDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime());

const optionalText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The one narrowing from the engine's user to the app's row type. It checks what it claims: the
 * core columns have their runtime types and every exposed column is present. The exposed columns'
 * own types are the table's, written by the same engine through the same table, so presence is
 * the property that can break (a column the engine was not told about).
 */
function isUserRow<U>(user: object, fields: readonly string[]): user is U & object {
  const value = (key: string): unknown => Reflect.get(user, key);
  return (
    typeof value('id') === 'string' &&
    typeof value('name') === 'string' &&
    typeof value('email') === 'string' &&
    typeof value('emailVerified') === 'boolean' &&
    (value('image') === null || value('image') === undefined || typeof value('image') === 'string') &&
    isDate(value('createdAt')) &&
    isDate(value('updatedAt')) &&
    fields.every(field => value(field) !== undefined)
  );
}

/** The session id, checked to be a string. Its brand is the table's, which the engine wrote. */
export function isSessionId<SId extends string>(id: unknown): id is SId {
  return typeof id === 'string' && id !== '';
}

/** The user id, checked to be a string. Its brand is the table's, which the engine wrote. */
export function isUserId<UId extends string>(id: unknown): id is UId {
  return typeof id === 'string' && id !== '';
}

/** The engine's session row as the app sees it: no token. A missing id or date is `ARKI_AUTH_E004`. */
export function toPrincipalSession<SId extends string>(session: object): PrincipalSession<SId> {
  const sessionId: unknown = Reflect.get(session, 'id');
  const createdAt: unknown = Reflect.get(session, 'createdAt');
  const expiresAt: unknown = Reflect.get(session, 'expiresAt');
  if (!isSessionId<SId>(sessionId) || !isDate(createdAt) || !isDate(expiresAt)) {
    throw shapeError('session lacks its id, createdAt or expiresAt');
  }
  return {
    id: sessionId,
    createdAt,
    expiresAt,
    ipAddress: optionalText(Reflect.get(session, 'ipAddress')),
    userAgent: optionalText(Reflect.get(session, 'userAgent')),
  };
}

/**
 * The engine's user as the app's row: the core columns and the exposed ones, nothing else. A
 * missing column is `ARKI_AUTH_E004`.
 */
export function toUserRow<U>(engineUser: object, fields: readonly string[]): U {
  const keys = [...CORE_USER_KEYS, ...fields];
  const missing = keys.filter(key => key !== 'image' && Reflect.get(engineUser, key) === undefined);
  if (missing.length > 0) throw shapeError(`user lacks ${missing.map(key => `"${key}"`).join(', ')}`);
  const picked: Record<string, unknown> = {};
  for (const key of keys) picked[key] = Reflect.get(engineUser, key) ?? null;
  if (!isUserRow<U>(picked, fields)) throw shapeError('user has a core column of the wrong type');
  return picked;
}

export type ToPrincipalInput = {
  /** The engine's user object. */
  readonly user: object;
  /** The engine's session object. */
  readonly session: object;
  /** The exposed extra columns. Only these and the core columns reach the principal. */
  readonly fields: readonly string[];
  readonly via: PrincipalVia;
  /** Read `activeOrganizationId` / `activeTeamId` from the session. */
  readonly workspaces: boolean;
};

/**
 * Builds the principal from the engine's session. Keeps only the core and the exposed columns, so
 * a column the definition does not expose never reaches a handler or the browser. A missing core
 * or exposed column is `ARKI_AUTH_E004`. `roles` runs on the narrowed user; its failure is thrown,
 * never turned into a guest.
 */
export async function toPrincipal<U, SId extends string>(
  input: ToPrincipalInput,
  roles: (user: U) => readonly string[] | Promise<readonly string[]>,
): Promise<Principal<U, SId>> {
  const { session, fields, via, workspaces } = input;
  const user = toUserRow<U>(input.user, fields);
  return {
    user,
    session: toPrincipalSession<SId>(session),
    via,
    roles: await roles(user),
    ...(workspaces && {
      workspace: {
        activeOrganizationId: optionalText(Reflect.get(session, 'activeOrganizationId')),
        activeTeamId: optionalText(Reflect.get(session, 'activeTeamId')),
      },
    }),
  };
}
