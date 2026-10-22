/**
 * Authorization as plain functions. A policy says whether a principal may do one thing to one
 * subject: `({ principal, order }) => order.customerId === principal.user.id`. Policies live in
 * groups, one group per subject, and are named `group.action` (`order.refund`).
 *
 * The optional `view` policy of a group is reserved: it decides whether the principal may know the
 * subject exists. `view` false answers like a missing row (404); the action false answers 403.
 *
 * This module is pure: no oRPC, no http, no database. The transports check with `can` (in
 * `@arki/auth/orpc`) and `authorize` (in `@arki/auth/http`).
 *
 * @example
 * export const orderPolicies = definePolicies<{ order: Order }>()({
 *   order: {
 *     view: ({ principal, order }) => principal.roles.includes('staff') || order.customerId === principal.user.id,
 *     refund: ({ order }) => order.status !== 'shipped',
 *   },
 * });
 */
import type { AnyPrincipal } from './principal.js';
import { AccessDenied, ResourceMissing } from './boundary-failures.js';
import { log } from './log.js';

/** What every policy of group `K` receives: the principal, and the subject under the group's name. */
export type PolicyArgs<P, K extends string, S> = { readonly principal: P } & Readonly<Record<K, S>>;

/** One rule: may this principal do this to this subject? A throw is a bug, never a refusal. */
export type Policy<P, K extends string, S> = (args: PolicyArgs<P, K, S>) => boolean | Promise<boolean>;

/** One group per subject. A group named `principal` does not compile: it would hide the principal. */
export type PolicyTree<Subjects, P> = {
  readonly [K in keyof Subjects & string]: Readonly<Record<string, Policy<P, K, Subjects[K]>>>;
} & { readonly principal?: never };

/** The policies `definePolicies` returns: the tree, plus the types it was written for. */
export type Policies<Subjects, P, T> = {
  readonly tree: T;
  /**
   * Type-only, never set: the subjects and the principal. `principal` is a parameter on purpose,
   * so a check accepts any principal that has at least what the policies read.
   */
  readonly '~types'?: { readonly subjects: Subjects; readonly principal: (principal: P) => void };
};

/**
 * Any policy, with its argument erased. A method signature, so a policy written for one subject
 * still fits: TypeScript compares method parameters both ways. Only `decide` calls it, with the
 * argument built from the same group key.
 */
type ErasedPolicy = {
  check(args: { readonly principal: AnyPrincipal } & Readonly<Record<string, unknown>>): boolean | Promise<boolean>;
}['check'];

/** Any result of `definePolicies`. */
export type AnyPolicies = {
  readonly tree: Readonly<Record<string, Readonly<Record<string, ErasedPolicy>>>>;
  readonly '~types'?: {
    readonly subjects: Readonly<Record<string, object>>;
    readonly principal: (principal: never) => void;
  };
};

type TreeOf<T extends AnyPolicies> = T['tree'];

/** `'order.view' | 'order.refund'`, read from the policies. */
export type PolicyName<T extends AnyPolicies> = {
  [G in keyof TreeOf<T> & string]: `${G}.${keyof TreeOf<T>[G] & string}`;
}[keyof TreeOf<T> & string];

/** The group of a policy name: `'order'` for `'order.refund'`. */
export type GroupOf<N extends string> = string extends N ? string : N extends `${infer G}.${string}` ? G : never;

/** The subject a policy checks: `Order` for `'order.refund'`. */
export type SubjectOf<T extends AnyPolicies, N extends string> = NonNullable<T['~types']>['subjects'][GroupOf<N>];

/** The principal type the policies were written for. */
export type PrincipalOfPolicies<T extends AnyPolicies> = NonNullable<T['~types']>['principal'] extends (
  principal: infer P,
) => void
  ? P
  : never;

/** Policies a principal of type `P` can be checked against: `P` has everything they read. */
export type PoliciesFor<P> = AnyPolicies & {
  readonly '~types'?: { readonly principal: (principal: P) => void };
};

/** What a loader returns: the subject, or `null` when there is no such row. */
export type Loaded<S> = S | null | Promise<S | null>;

/**
 * Group policies by subject. The first call takes the subject types (and, optionally, the app's
 * principal when a policy reads an exposed column); the second takes the tree, whose names are
 * inferred. Two calls, because TypeScript cannot take some type arguments and infer the rest.
 */
export function definePolicies<Subjects extends Record<string, object>, P extends AnyPrincipal = AnyPrincipal>(): <
  const T extends PolicyTree<Subjects, P>,
>(
  tree: T,
) => Policies<Subjects, P, T> {
  return wrapTree;
}

function wrapTree<T>(tree: T): { readonly tree: T } {
  return { tree };
}

/** Why a check refused: no such row, a `view` that hides it, or the action refused. */
export type RefusalOutcome = 'missing' | 'hidden' | 'forbidden';

/** The result of one check after sign-in: the subject when allowed, the refusal otherwise. */
export type Decision<S> =
  { readonly allowed: true; readonly subject: S } | { readonly allowed: false; readonly outcome: RefusalOutcome };

/** The group of a policy name, typed: `'order'` for `'order.refund'`. */
export function groupOf<N extends string>(name: N): GroupOf<N> {
  const group = name.slice(0, Math.max(0, name.indexOf('.')));
  if (!isGroupOf(name, group)) throw new Error(`"${name}" is not a policy name (group.action).`);
  return group;
}

/** The check that makes `groupOf` sound: `group` is exactly what comes before the first dot. */
function isGroupOf<N extends string>(name: N, group: string): group is GroupOf<N> {
  return group.length > 0 && !group.includes('.') && name.startsWith(`${group}.`);
}

/**
 * Run one named check for a signed-in principal and an already-loaded subject (`null` = missing).
 * Order: missing → `view` (when the group has one) → the action. Each refusal writes one debug
 * line with the policy name, the principal's id and the outcome. A policy that throws is rethrown.
 */
export async function decide<S>(
  policies: AnyPolicies,
  name: string,
  principal: AnyPrincipal,
  subject: S | null,
): Promise<Decision<S>> {
  const refuse = (outcome: RefusalOutcome): Decision<S> => {
    log.debug('Policy {policy} refused {principalId}: {outcome}', {
      policy: name,
      principalId: principal.user.id,
      outcome,
    });
    return { allowed: false, outcome };
  };
  if (subject === null) return refuse('missing');
  const outcome = await refusal(policies, name, principal, subject);
  return outcome === undefined ? { allowed: true, subject } : refuse(outcome);
}

async function refusal(
  policies: AnyPolicies,
  name: string,
  principal: AnyPrincipal,
  subject: unknown,
): Promise<RefusalOutcome | undefined> {
  const group = groupOf(name);
  const action = name.slice(group.length + 1);
  const rules = policies.tree[group];
  const args = { principal, [group]: subject };
  const view = rules?.['view'];
  if (view !== undefined && !(await view(args))) return 'hidden';
  if (action === 'view') return undefined;
  const rule = rules?.[action];
  // The types only allow names in the tree; this is reached only when the tree was changed at runtime.
  if (rule === undefined) throw new Error(`Policy "${name}" is not defined.`);
  return (await rule(args)) ? undefined : 'forbidden';
}

/**
 * `{ [key]: value }` with its key kept in the type. TypeScript widens a computed key to `string`;
 * the check below proves the key holds the value, so the narrowing is sound.
 */
export function keyed<K extends string, V>(key: K, value: V): Readonly<Record<K, V>> {
  const entry = { [key]: value };
  if (!holds(entry, key, value)) throw new Error(`Could not set "${key}".`);
  return entry;
}

function holds<K extends string, V>(entry: object, key: K, value: V): entry is Readonly<Record<K, V>> {
  return Object.hasOwn(entry, key) && Reflect.get(entry, key) === value;
}

/** A policy result as a canonical value; missing and hidden never disclose different data. */
export async function authorizePolicy<S>(
  policies: AnyPolicies,
  name: string,
  principal: AnyPrincipal,
  subject: S | null,
) {
  const decision = await decide(policies, name, principal, subject);
  if (decision.allowed) return decision.subject;
  return decision.outcome === 'forbidden' ? AccessDenied() : ResourceMissing();
}
