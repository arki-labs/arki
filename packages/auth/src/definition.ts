/**
 * The auth declaration: plain data that the server factory, the client and the sign-in form all
 * read. It imports no engine and no database code, so the start app can import the same object.
 *
 * @example
 * export const authDefinition = defineAuth({
 *   app: { name: 'Notes', key: 'notes' },
 *   methods: ['password', 'magicLink', 'google'],
 *   user: { fields: ['plan'] },
 *   sessions: { bearer: true },
 * });
 */
import { AUTH_ERROR_CODES, AuthError } from './errors.js';

/** Social sign-in providers. Their credentials are runtime values, given to the server factory. */
export const SOCIAL_METHODS = ['google', 'apple', 'facebook', 'microsoft', 'github'] as const;
export type SocialMethod = (typeof SOCIAL_METHODS)[number];

/** Every sign-in method. Email OTP and passkeys are later work and are not accepted yet. */
export const AUTH_METHODS = ['password', 'magicLink', ...SOCIAL_METHODS] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** A duration in whole seconds. */
export type Seconds = number;

/**
 * What happens to a password sign-up's email address.
 *
 * - `'require'` (default): a verify link is sent and password sign-in waits until it is used.
 * - `'send'`: the link is sent, sign-in works before it is used.
 * - `'none'`: no link is sent.
 */
export type VerifyEmailMode = 'none' | 'send' | 'require';

/** Organizations (workspaces). `teams: true` adds teams inside each workspace. */
export type WorkspacesOption = { readonly teams: boolean };

/**
 * Account self-service. Each switch is off unless set to `true`.
 *
 * - `changeEmail`: the user can change their address. A verify link goes to the new address
 *   (the `verifyEmail` mail); the address changes only when that link is used.
 * - `linking`: social accounts can be linked to a signed-in user, and a social sign-in with an
 *   address the provider verified joins the existing user. Off: neither happens.
 * - `delete`: the user can delete their account (a fresh session or the password is required).
 *   The user row and every session go; tables that point at the user need `onDelete: 'cascade'`.
 */
export type AccountOptions = {
  readonly changeEmail?: boolean;
  readonly linking?: boolean;
  readonly delete?: boolean;
};

/**
 * The auth declaration. `M` is the literal tuple of enabled methods; `F` names the extra columns
 * of the app's user table that the principal and the client may see. Types for those columns come
 * from the table, never from here. `W` is the `workspaces` value as written, so the client knows
 * from the type alone whether to add the organization API.
 */
export type AuthDefinition<
  M extends readonly AuthMethod[] = readonly AuthMethod[],
  F extends readonly string[] = readonly string[],
  W extends WorkspacesOption | undefined = WorkspacesOption | undefined,
> = {
  /** `name` appears in mail; `key` prefixes the cookies (`auth-<key>`). */
  readonly app: { readonly name: string; readonly key: string };
  readonly methods: M;
  /** `fields`: extra user columns to expose (default none). `signUpFields`: those a client may set at sign-up. */
  readonly user?: { readonly fields?: F; readonly signUpFields?: readonly F[number][] };
  /** Default `'require'`. */
  readonly verifyEmail?: VerifyEmailMode;
  /** Defaults: 7 days, refreshed at most once a day, no bearer tokens. */
  readonly sessions?: { readonly expiresIn?: Seconds; readonly refreshEvery?: Seconds; readonly bearer?: boolean };
  /** `signUp: false` makes magic links sign-in only. Default `true`. */
  readonly magicLink?: { readonly signUp?: boolean };
  /** Organizations (workspaces), optionally with teams. Needs the workspace tables. */
  readonly workspaces?: W;
  /** Account self-service: change email, link accounts, delete the account. All off by default. */
  readonly account?: AccountOptions;
  /** Accept the Expo client (native apps). Default `false`. */
  readonly expo?: boolean;
};

/** The extra user column names a definition exposes. */
export type ExposedFields<D> = D extends { readonly user?: { readonly fields?: infer F } }
  ? F extends readonly string[]
    ? F[number]
    : never
  : never;

/** The social methods a definition enables. */
export type SocialMethodsOf<D> = D extends { readonly methods: infer M }
  ? M extends readonly AuthMethod[]
    ? Extract<M[number], SocialMethod>
    : never
  : never;

const DAY: Seconds = 24 * 60 * 60;

/** A definition with every default filled in. */
export type ResolvedDefinition = {
  readonly app: { readonly name: string; readonly key: string };
  readonly methods: readonly AuthMethod[];
  readonly fields: readonly string[];
  readonly signUpFields: readonly string[];
  readonly verifyEmail: VerifyEmailMode;
  readonly sessions: { readonly expiresIn: Seconds; readonly refreshEvery: Seconds; readonly bearer: boolean };
  readonly magicLink: { readonly signUp: boolean };
  readonly workspaces: WorkspacesOption | undefined;
  readonly account: { readonly changeEmail: boolean; readonly linking: boolean; readonly delete: boolean };
  readonly expo: boolean;
};

/** User columns the engine owns. A definition cannot expose them again as extra fields. */
const CORE_USER_FIELDS = new Set(['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt']);

const AUTH_METHOD_NAMES = new Set<string>(AUTH_METHODS);
const SOCIAL_METHOD_NAMES = new Set<string>(SOCIAL_METHODS);

const isAuthMethod = (value: string): value is AuthMethod => AUTH_METHOD_NAMES.has(value);

export const isSocialMethod = (value: string): value is SocialMethod => SOCIAL_METHOD_NAMES.has(value);

function invalid(message: string): never {
  throw new AuthError(AUTH_ERROR_CODES.invalidConfig, `[@arki/auth] ${message}`);
}

function assertSeconds(value: Seconds, label: string): void {
  if (!Number.isInteger(value) || value <= 0) invalid(`${label} must be a positive whole number of seconds.`);
}

function duplicateOf(values: readonly string[]): string | undefined {
  return values.find((value, index) => values.indexOf(value) !== index);
}

/**
 * Checks a definition and fills its defaults. Throws `ARKI_AUTH_E001` on the first mistake.
 * The factory calls it again, so a hand-written object gets the same checks.
 */
export function resolveDefinition(definition: AuthDefinition): ResolvedDefinition {
  const { app, methods, user, sessions, magicLink, workspaces, account } = definition;
  if (app.name.trim() === '') invalid('`app.name` is empty.');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(app.key)) {
    invalid(`\`app.key\` "${app.key}" must be lower-case letters, digits and dashes (it prefixes the cookies).`);
  }
  if (methods.length === 0) invalid('`methods` is empty: enable at least one sign-in method.');
  // Read as plain strings: a caller without the types can pass anything.
  const names: readonly string[] = methods;
  const unknownMethod = names.find(method => !isAuthMethod(method));
  if (unknownMethod !== undefined) invalid(`Unknown method "${unknownMethod}". Known: ${AUTH_METHODS.join(', ')}.`);
  const repeatedMethod = duplicateOf(methods);
  if (repeatedMethod !== undefined) invalid(`Method "${repeatedMethod}" is listed twice.`);

  const fields = user?.fields ?? [];
  const signUpFields = user?.signUpFields ?? [];
  const repeatedField = duplicateOf(fields);
  if (repeatedField !== undefined) invalid(`\`user.fields\` lists "${repeatedField}" twice.`);
  const coreField = fields.find(field => CORE_USER_FIELDS.has(field));
  if (coreField !== undefined) invalid(`\`user.fields\` cannot list "${coreField}": the engine already owns it.`);
  const strayField = signUpFields.find(field => !fields.includes(field));
  if (strayField !== undefined)
    invalid(`\`user.signUpFields\` lists "${strayField}", which is not in \`user.fields\`.`);

  const expiresIn = sessions?.expiresIn ?? 7 * DAY;
  const refreshEvery = sessions?.refreshEvery ?? DAY;
  assertSeconds(expiresIn, '`sessions.expiresIn`');
  assertSeconds(refreshEvery, '`sessions.refreshEvery`');
  if (refreshEvery >= expiresIn) invalid('`sessions.refreshEvery` must be shorter than `sessions.expiresIn`.');

  if (magicLink !== undefined && !methods.includes('magicLink')) {
    invalid('`magicLink` options are set but the `magicLink` method is not enabled.');
  }

  return {
    app,
    methods,
    fields,
    signUpFields,
    verifyEmail: definition.verifyEmail ?? 'require',
    sessions: { expiresIn, refreshEvery, bearer: sessions?.bearer ?? false },
    magicLink: { signUp: magicLink?.signUp ?? true },
    workspaces,
    account: {
      changeEmail: account?.changeEmail ?? false,
      linking: account?.linking ?? false,
      delete: account?.delete ?? false,
    },
    expo: definition.expo ?? false,
  };
}

/**
 * Declares the app's auth. Returns the definition unchanged after checking it; the point is the
 * literal types: `methods` and `user.fields` keep their exact names for the server, the client and
 * the principal, and `workspaces` stays as written for the client.
 */
export function defineAuth<
  const M extends readonly AuthMethod[],
  const F extends readonly string[] = readonly [],
  const W extends WorkspacesOption | undefined = undefined,
>(definition: AuthDefinition<M, F, W>): AuthDefinition<M, F, W> {
  resolveDefinition(definition);
  return definition;
}
