/**
 * `defineFeature(name)` — the chain form of a Dot feature
 * (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`; nesting and infra
 * needs: `docs/rfcs/2026-10-15-dot-feature-builder-nesting.md`).
 *
 *   defineFeature('daily-digest')
 *     .needs({ db: entrypointOnly(database.provides.db), plans: billing.provides.entitlements })
 *     .infra(store, mailer)                              its own units, private to it
 *     .domainServices({ extras })                        domain services, built once; usecases and children see them
 *     .features(compile, deliver)                       its nested features, named `daily-digest.<child>`
 *     .usecases({ preview, send })                       what it does: one factory per usecase
 *     .provides({ digests: ({ usecases }) => … })        what it offers other features
 *     .entrypoints(rpc(…), schedules(…), …)              how it is reached
 *
 * Each step's type offers only the later steps, so a step out of order does
 * not compile. Each step's input is typed from the earlier ones: usecases get
 * `{ ...needs, ...infra, ...children }` (minus the entrypoint-only needs);
 * `provides` factories and entrypoints get the same plus `usecases`.
 *
 * Handles enter a feature through one door, `.needs()`. An infra unit names
 * the handles it needs (`db: database.provides.db`) or declares them unbound
 * (`service<Db>()`); `.infra()` binds each alias to a sibling's key first, then
 * to the feature's need of the same alias, and refuses a handle that is not
 * the feature's.
 *
 * The feature compiles to plain kernel units (`units()`): every infra
 * unit, its keys qualified as `<feature>.<key>` and its unit named
 * `<feature>/<unit>`, then each child's units, then one feature unit.
 * Nothing in the kernel changes: ordering, rings, the manifest and
 * `dot explain` see ordinary units with ordinary edges
 * (`digest → digest/store → database`, `digest.compile → digest/store`).
 */
import type { Failure, FailureIn } from '@arki/failure';
import { isFailure, UnexpectedDefect } from '@arki/failure';

import type { FeatureSlice } from './feature.js';
import type { SupervisedUsecase } from './kernel/usecase.js';
import type {
  ActionSource,
  AnyHandle,
  AnyUnit,
  CheckedProvider,
  CtxOf,
  EmptyShape,
  FactoryContract,
  FactoryContractOf,
  Handle,
  InferredOwnership,
  KernelCtx,
  LazyService,
  NeedsShape,
  NoReservedKeys,
  Provided,
  ProvidedValue,
  ProvidedValues,
  Service,
  ServiceRecord,
  Unit,
  UnitNeeds,
  UnitOwner,
  UnitOwnership,
  UnitPhaseFailures,
  UnitPreparation,
  UnitProviderIdentities,
  UnitProvides,
  UnitRuntime,
  WireNeeds,
} from './unit-contract.js';
import { FEATURE_ERROR_CODES, FeatureError } from './feature-error.js';
import { traceUsecase } from './kernel/otel.js';
import { superviseUsecase } from './kernel/usecase.js';
import { createUnitRuntime, handleOf, HANDLERS_KEY, isLazyWitness, rename } from './unit-contract.js';

type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer I) => void
  ? I
  : never;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * Names a feature may not use for a need alias, an infra key or a provided
 * key: the request context's own keys (`session`, `headers`, `services`) and
 * the `usecases` slot. A handler context spreads the feature's handles next
 * to the request keys, so a private `session` would replace the real one.
 */
export type ReservedAlias = 'session' | 'headers' | 'services' | 'usecases';

const RESERVED: ReadonlySet<string> = new Set<ReservedAlias>(['session', 'headers', 'services', 'usecases']);

type NoKeys<K extends string> = Partial<Readonly<Record<K, never>>>;

/** The services the infra units provide, merged, under their local keys. */
export type InfraProvides<I extends readonly AnyUnit[]> = I extends readonly []
  ? EmptyShape
  : UnionToIntersection<UnitProvides<I[number]>>;

/**
 * A need only entrypoints receive — a `db` to open a transaction with:
 * `needs({ db: entrypointOnly(database.provides.db) })`. The flag survives `.lazy`.
 */
export type EntrypointOnly<H> = H & {
  readonly entrypointOnly: true;
  readonly lazy: (H extends { readonly lazy: infer L } ? L : never) & { readonly entrypointOnly: true };
};

/** The needs usecases may see: every need that is not entrypoint-only. */
export type UsecaseNeeds<N extends NeedsShape> = {
  [K in keyof N as N[K] extends { readonly entrypointOnly: true } ? never : K]: N[K];
};

/** The aliases of the needs declared with `entrypointOnly(...)`. */
type EntrypointOnlyKeys<N extends NeedsShape> = {
  [K in keyof N]: N[K] extends { readonly entrypointOnly: true } ? K : never;
}[keyof N];

/**
 * What `.usecases(create)` receives: the usecase-visible needs by alias, the infra services, the domain
 * services `S` and the children's services by local key. With `C = []` and no `S` it is what a domain
 * service may ask for (`DomainDeps`).
 */
export type CoreDeps<
  N extends NeedsShape,
  I extends readonly AnyUnit[],
  C extends readonly AnyDefinedFeature[],
  S = EmptyShape,
> = CtxOf<UsecaseNeeds<N>> & InfraProvides<I> & S & ChildProvides<C>;

/** The needs only entrypoints receive: the complement of {@link UsecaseNeeds}. */
export type EntrypointOnlyNeeds<N extends NeedsShape> = Pick<N, EntrypointOnlyKeys<N>>;

/**
 * What a `.provides` factory receives (with the kernel's `$` keys): the usecases, nothing else.
 * A trivial read becomes a one-line usecase, so every cross-feature call is traced and supervised.
 */
export type ProvidesDeps<U> = { readonly usecases: UsecaseValues<U> };

/**
 * What every entrypoint receives (with the kernel's `$` keys) and `<feature>.services` holds: the
 * entrypoint-only needs and the usecases. Infra, plain needs, children and domain services stay below
 * the usecases; request keys (`session`, `headers`) come from the request context. Most features have
 * no entrypoint-only need, so that case skips `CtxOf` (the 50-feature typecheck probe drops by ~25k).
 */
export type EntrypointServices<N extends NeedsShape, U> = ([EntrypointOnlyKeys<N>] extends [never]
  ? EmptyShape
  : CtxOf<EntrypointOnlyNeeds<N>>) & {
  readonly usecases: UsecaseValues<U>;
};

/**
 * An entrypoint descriptor — the protocol adapter packages implement
 * (`rpc`, `schedules`, `journalEffects`, `endpoints`). Structural on purpose:
 * an adapter imports nothing from Dot at runtime.
 *
 * - `kind` names the descriptor (`'rpc'`, `'schedules'`, …).
 * - `key` is its slot in the slice record the feature publishes under
 *   `feature.<name>`; the app-level adapter reads it with `sliceOf`.
 * - `actions` join the feature's manifest before anything boots.
 * - `resolve` runs when the feature boots, with the feature's needs, infra
 *   and usecases; its return is the payload under `key`.
 */
export type Entrypoint<TServices = never> = FeatureSlice<string, unknown, TServices> & {
  readonly kind: string;
  /**
   * Actions whose ids need the feature's name. Action ids are unique per
   * binding across the app, and a procedure called `list` lives in many
   * features — so `rpc()` names its actions `<feature>.<procedure>` here.
   * Called when the feature compiles, with its declared children, so a
   * child's mounted procedures are declared once, by the child.
   */
  readonly actionsOf?: (feature: string, children: readonly AnyDefinedFeature[]) => readonly ActionSource[];
};

/** The erased entrypoint — what helpers that only read `kind` / `key` / `actions` accept. */
export type AnyEntrypoint = Entrypoint<never>;

/**
 * The one descriptor with static data: the feature's oRPC contract and the
 * router that implements it. `DefinedFeature.contract` / `.router` are read
 * from it, so `routerFor(rpcContract, features)` finds each feature by its
 * contract. (`rpc(contract, implementer, procedures)` in `@arki/dot/orpc` builds it and
 * checks the router against the contract.)
 */
export type RpcEntrypoint<C extends object = object, R = unknown> = Entrypoint<unknown> & {
  readonly kind: 'rpc';
  readonly key: 'rpc';
  readonly contract: C;
  readonly router: R;
};

type RpcIn<E extends readonly AnyEntrypoint[]> = Extract<E[number], { readonly kind: 'rpc' }>;

/** The contract of a feature's `rpc` entrypoint; `never` when it has none. */
export type ContractOf<E extends readonly AnyEntrypoint[]> = [RpcIn<E>] extends [never]
  ? never
  : RpcIn<E> extends { readonly contract: infer C }
    ? C
    : never;

/** The router of a feature's `rpc` entrypoint; `never` when it has none. */
export type RouterOf<E extends readonly AnyEntrypoint[]> = [RpcIn<E>] extends [never]
  ? never
  : RpcIn<E> extends { readonly router: infer R }
    ? R
    : never;

/** The slice record a feature publishes under `feature.<name>`: entrypoint key → resolved payload. */
export type EntrypointPayloads<E extends readonly AnyEntrypoint[]> = {
  readonly [X in E[number] as X['key']]: X extends FeatureSlice<string, infer P, never> ? P : never;
};

type Qualify<TName extends string, K> = K extends string ? `${TName}.${K}` : never;

/* ---- nesting: a child is a finished feature named `<parent>.<child>` ---- */

/** A nested name has a dot; a top-level name has none. */
type Nested<TName extends string> = TName extends `${string}.${string}` ? true : false;

/** An instance is named `<feature>#<instance>` (`reports#eu`); its children carry the mark in their prefix. */
type Instanced<TName extends string> = TName extends `${string}#${string}` ? true : false;

/** The wire key of a provided service: bare at the top level, `<name>.<key>` inside a parent or for an instance. */
type PublishKey<TName extends string, K> = K extends string
  ? Nested<TName> extends true
    ? `${TName}.${K}`
    : Instanced<TName> extends true
      ? `${TName}.${K}`
      : K
  : never;

/** `digest.compile.rank` → `digest.compile`; a top-level name has no parent (`never`). */
type ParentOf<F extends string> = F extends `${infer H}.${infer T}`
  ? [ParentOf<T>] extends [never]
    ? H
    : `${H}.${ParentOf<T>}`
  : never;

/** The scope of a feature's provides: its parent, or public at the top level. */
type ScopeFor<TName extends string> = [ParentOf<TName>] extends [never] ? undefined : ParentOf<TName>;

/**
 * A handle with explicit ownership: `scope` is the feature inside which it may
 * be needed (`undefined` = public); `internal` marks the feature's own
 * usecases/services/slice, which nothing may need. Both survive `.lazy`.
 * `needs()` and `.infra()` read only this metadata — nothing derived from names.
 */
export type ScopedHandle<
  T,
  K extends string,
  O extends string,
  S extends string | undefined,
  Internal extends boolean = false,
> = Handle<T, K, O> & {
  readonly scope: S;
  readonly internal: Internal;
  readonly lazy: Handle<T, K, O>['lazy'] & { readonly scope: S; readonly internal: Internal };
};

/** The handles a feature unit publishes: public provides scoped to the parent; usecases/services/slice internal. */
type UnitHandles<TName extends string, Pub extends ServiceRecord, Own extends ServiceRecord> = {
  readonly [K in keyof Pub as K & string]: ScopedHandle<Pub[K], K & string, TName, ScopeFor<TName>>;
} & { readonly [K in keyof Own as K & string]: ScopedHandle<Own[K], K & string, TName, TName, true> };

/** The handles a qualified infra unit publishes: scoped to the feature. */
type InfraUnitHandles<TName extends string, P extends ServiceRecord> = {
  readonly [K in keyof P as K & string]: ScopedHandle<P[K], K & string, `${TName}/${string}`, TName>;
};

/** One handle per provided key (local key → handle on the published wire key). */
export type ScopedHandles<P extends ServiceRecord, TName extends string> = {
  readonly [K in keyof P as K & string]: ScopedHandle<P[K], PublishKey<TName, K & string>, TName, ScopeFor<TName>>;
};

/** The children's public handles, merged, by local key. */
export type ChildHandles<C extends readonly AnyDefinedFeature[]> = C extends readonly []
  ? EmptyShape
  : UnionToIntersection<C[number]['provides']>;

type ProvidesOf<F> = F extends { readonly provides: infer H } ? { readonly [K in keyof H]: Provided<H[K]> } : never;

/** The children's public services, merged, by local key — what the parent's usecases see. */
export type ChildProvides<C extends readonly AnyDefinedFeature[]> = C extends readonly []
  ? EmptyShape
  : UnionToIntersection<ProvidesOf<C[number]>>;

/** The `provider` literals of a handle record (`string` when the unit was typed without its name). */
type HandleProviders<H> = {
  [K in keyof H]: H[K] extends { readonly provider: infer O extends string } ? O : never;
}[keyof H];
/** The names of a feature's infra units, read off their raw handles — what a child's need may name to reach them. */
type InfraOwners<I extends readonly AnyUnit[]> = {
  [J in keyof I]: I[J] extends AnyUnit ? HandleProviders<I[J]['provides']> : never;
}[number];
/** The `provider` of the witness that resolves to wire key `K` in a needs shape: a literal, `string` (erased), or `never` (anonymous). */
type ProviderOfWireKey<S extends NeedsShape, K> = {
  [A in keyof S]: WireKeyOfNeed<S[A], A> extends K
    ? S[A] extends { readonly provider: infer O extends string }
      ? O
      : never
    : never;
}[keyof S];
/**
 * Where a child unit's need on wire key `K` lands once the parent mounts it —
 * the compile-time `remapNeeds`. A need is remapped onto the parent's scope
 * only when it names one of the parent's own infra handles (the witness's
 * `provider` is one of `Owners`), exactly as the runtime remaps by handle
 * identity. An anonymous witness never remaps: the kernel resolves it by wire
 * key, so the app must provide it. Where identity is unknown — the shape or
 * the provider was erased by a `Unit<N, P>` annotation — the key rule
 * stands in, as it did before identities existed.
 */
type RemappedKey<TName extends string, TLocal, Owners extends string, S extends NeedsShape, K> = K extends TLocal
  ? string extends keyof S
    ? Qualify<TName, K>
    : string extends ProviderOfWireKey<S, K>
      ? Qualify<TName, K>
      : [ProviderOfWireKey<S, K>] extends [never]
        ? K
        : ProviderOfWireKey<S, K> extends Owners
          ? Qualify<TName, K>
          : K
  : K;
/**
 * A child unit with its needs on the parent's infra handles remapped to the
 * qualified keys (see {@link RemappedKey}). The unit's own typed `provides`
 * record is kept, so its handles stay scoped/internal after the remap (Astra
 * round 3); its needs shape is kept, so a grandparent reads the same identities.
 */
type RemappedUnit<TName extends string, TLocal, Owners extends string, P extends AnyUnit> = Omit<
  Unit<
    {
      [K in keyof UnitNeeds<P> as RemappedKey<TName, TLocal, Owners, UnitProviderIdentities<P>, K>]: UnitNeeds<P>[K];
    },
    UnitProvides<P>,
    UnitProviderIdentities<P>,
    UnitOwner<P>,
    UnitPreparation<P>,
    UnitPhaseFailures<P>
  >,
  'runtime' | 'hooks' | 'factories' | 'logging'
> &
  Pick<P, 'runtime' | 'hooks' | 'factories' | 'logging' | 'provides'> &
  FactoryContractOf<P>;
type RemappedUnits<TName extends string, TLocal, Owners extends string, U extends readonly AnyUnit[]> = {
  readonly [K in keyof U]: U[K] extends AnyUnit ? RemappedUnit<TName, TLocal, Owners, U[K]> : never;
};
/** Every child's units, in declaration order, each remapped onto the parent's scope. */
export type ChildUnits<
  TName extends string,
  TLocal,
  Owners extends string,
  C extends readonly AnyDefinedFeature[],
  Acc extends readonly AnyUnit[] = readonly [],
> = C extends readonly [infer H extends AnyDefinedFeature, ...infer T extends readonly AnyDefinedFeature[]]
  ? ChildUnits<
      TName,
      TLocal,
      Owners,
      T,
      readonly [...Acc, ...RemappedUnits<TName, TLocal, Owners, ReturnType<H['units']>>]
    >
  : Acc;
/** The whole unit list of a feature with children: infra, children, then the feature itself. */
export type UnitsOf<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyUnit[],
  C extends readonly AnyDefinedFeature[],
  Unit extends AnyUnit,
> =
  ChildUnits<TName, keyof InfraProvides<I>, InfraOwners<I>, C, QualifiedInfra<TName, N, I>> extends infer U extends
    readonly AnyUnit[]
    ? readonly [...U, Unit]
    : never;

/** Needs on internal handles (a feature's `usecases`/`services`/slice): never allowed, from anywhere. */
type InternalNeeds<N> = { [K in keyof N]: N[K] extends { readonly internal: true } ? K : never }[keyof N];
/** Needs whose handle carries a `scope` this feature is not inside of. A handle without `scope` is public. */
type OutOfScope<TName extends string, N> = {
  [K in keyof N]: N[K] extends { readonly internal: true }
    ? never
    : N[K] extends { readonly scope: infer S extends string }
      ? TName extends S | `${S}.${string}`
        ? never
        : K
      : never;
}[keyof N];
/** Needs written with `domainService(fn)`: only a child may have them, its parent binds them. */
type DomainServiceNeeds<N> = { [K in keyof N]: N[K] extends { readonly domainService: unknown } ? K : never }[keyof N];
/** A need may name a public handle, its own scope's private infra, or a nested feature's provides from inside that feature's parent. */
export type NeedsGuard<TName extends string, N> = ([InternalNeeds<N>] extends [never]
  ? unknown
  : {
      readonly "DOT: a need names a feature's internal handle (usecases/services); need its provides instead": InternalNeeds<N>;
    }) &
  ([OutOfScope<TName, N>] extends [never]
    ? unknown
    : {
        readonly "DOT: a need reaches a private service from outside its scope (a feature's infra, or a nested feature's provides)": OutOfScope<
          TName,
          N
        >;
      }) &
  (Nested<TName> extends true
    ? unknown
    : [DomainServiceNeeds<N>] extends [never]
      ? unknown
      : {
          readonly "DOT: domainService(...) names a parent's domain service; only a child may need it": DomainServiceNeeds<N>;
        });

type ChildName<C> = C extends { readonly name: infer X extends string } ? X : never;
type NotChildName<TName extends string, C extends readonly AnyDefinedFeature[]> = {
  [K in keyof C]: ChildName<C[K]> extends `${TName}.${string}` ? never : ChildName<C[K]>;
}[number];
type ChildKeyCollision<
  N,
  I extends readonly AnyUnit[],
  C extends readonly AnyDefinedFeature[],
  F,
> = keyof ChildProvides<C> & (keyof N | keyof InfraProvides<I> | keyof F | ReservedAlias);
type SiblingDup<C extends readonly AnyDefinedFeature[], Seen = never> = C extends readonly [
  infer H extends AnyDefinedFeature,
  ...infer T extends readonly AnyDefinedFeature[],
]
  ? (keyof H['provides'] & Seen) | SiblingDup<T, Seen | keyof H['provides']>
  : never;
/** `F` is the feature's domain-service factories: a child may need only those, by `domainService(fn)`. */
export type ChildrenGuard<
  TName extends string,
  N,
  I extends readonly AnyUnit[],
  C extends readonly AnyDefinedFeature[],
  F = EmptyShape,
> = ([NotChildName<TName, C>] extends [never]
  ? unknown
  : { readonly 'DOT: a child feature must be named `<parent>.<child>`': NotChildName<TName, C> }) &
  ([ChildKeyCollision<N, I, C, F>] extends [never]
    ? unknown
    : {
        readonly 'DOT: a child provides a key that collides with a need alias, an infra service, a domain service or a reserved name': ChildKeyCollision<
          N,
          I,
          C,
          F
        >;
      }) &
  ([SiblingDup<C>] extends [never] ? unknown : { readonly 'DOT: two children provide the same key': SiblingDup<C> }) &
  ([Exclude<ChildDomainNeeds<C>, F[keyof F]>] extends [never]
    ? unknown
    : {
        readonly 'DOT: a child needs a domain service this feature does not declare above .features()': Exclude<
          ChildDomainNeeds<C>,
          F[keyof F]
        >;
      });

/** Children whose rpc contract the feature's own contract does not mount under some key. */
type UnmountedChild<C extends readonly AnyDefinedFeature[], E extends readonly AnyEntrypoint[]> = {
  [K in keyof C]: [C[K]['contract']] extends [never]
    ? never
    : C[K]['contract'] extends ContractOf<E>[keyof ContractOf<E>]
      ? never
      : ChildName<C[K]>;
}[number];
type ChildContractGuard<C extends readonly AnyDefinedFeature[], E extends readonly AnyEntrypoint[]> = [
  UnmountedChild<C, E>,
] extends [never]
  ? unknown
  : {
      readonly "DOT: a child feature has an rpc contract this feature's contract does not mount": UnmountedChild<C, E>;
    };

/** The keys the feature generates for itself: a provides factory may not take them. */
type GeneratedKeys<TName extends string> = `${TName}.services` | `${TName}.usecases` | `feature.${TName}`;
/** Inside a parent, a provided key must not also be an infra key: both publish under `<name>.<key>`. */
type ProvidesGuard<TName extends string, I extends readonly AnyUnit[], P> = ([keyof P & GeneratedKeys<TName>] extends [
  never,
]
  ? unknown
  : {
      readonly 'DOT: a provided key is generated by the feature itself (services, usecases, feature slice)': keyof P &
        GeneratedKeys<TName>;
    }) &
  (Nested<TName> extends true
    ? [keyof P & keyof InfraProvides<I>] extends [never]
      ? unknown
      : { readonly 'DOT: a provided key collides with an infra service key': keyof P & keyof InfraProvides<I> }
    : unknown);

type LocalName<TName extends string, F extends string> = F extends `${TName}.${infer L}` ? L : never;
type OverridesOf<F> = F extends { override(values: infer V): unknown } ? V : never;
/** `override({ 'compile.ranker': fake })`: a child's overrides, keyed by its local name — recursive through the child's own type. */
export type ChildOverrides<TName extends string, C extends readonly AnyDefinedFeature[]> = C extends readonly []
  ? unknown
  : UnionToIntersection<
      C[number] extends infer X
        ? X extends { readonly name: infer Nm extends string }
          ? { readonly [K in keyof OverridesOf<X> & string as `${LocalName<TName, Nm>}.${K}`]?: OverridesOf<X>[K] }
          : never
        : never
    >;

/** The wire key a declared need resolves to: a handle's own key, else the alias. */
type WireKeyOfNeed<W, K> = W extends { readonly parentBound: true }
  ? never
  : W extends { readonly key: infer WK extends string }
    ? WK
    : K;

/**
 * An infra unit's needs shape once the feature owns it: an alias the
 * feature declares names the feature's handle — `qualifyInfra` substitutes
 * `declared[alias]` for the unit's witness — so a parent remapping this
 * unit later reads the feature's identity, as the runtime does.
 */
type OwnedShape<N extends NeedsShape, S extends NeedsShape> = string extends keyof S
  ? S
  : { [A in keyof S]: A extends keyof N ? N[A] : S[A] };

/**
 * An infra unit after qualification: it provides under `<feature>.<key>`;
 * a need that named a sibling infra key (`TLocal`) names the qualified key,
 * so the sibling — not an app unit — satisfies it; any other need alias is
 * the feature's need of that alias, on that handle's wire key.
 */
export type QualifiedUnit<TName extends string, N extends NeedsShape, P extends AnyUnit, TLocal> = Omit<
  Unit<
    {
      [
        K in keyof UnitNeeds<P> as K extends TLocal ? Qualify<TName, K> : K extends keyof N ? WireKeyOfNeed<N[K], K> : K
      ]: UnitNeeds<P>[K];
    },
    { [K in keyof UnitProvides<P> as Qualify<TName, K>]: UnitProvides<P>[K] },
    OwnedShape<N, UnitProviderIdentities<P>>,
    `${TName}/${string}`,
    UnitPreparation<P>,
    UnitPhaseFailures<P>
  >,
  'runtime' | 'hooks' | 'factories' | 'logging' | 'provides'
> &
  Pick<P, 'runtime' | 'hooks' | 'factories' | 'logging'> &
  FactoryContractOf<P> & {
    readonly provides: InfraUnitHandles<
      TName,
      { [K in keyof UnitProvides<P> as Qualify<TName, K>]: UnitProvides<P>[K] }
    >;
  };

/** Every infra unit qualified, as a tuple in declaration order. */
export type QualifiedInfra<TName extends string, N extends NeedsShape, I extends readonly AnyUnit[]> = {
  readonly [K in keyof I]: I[K] extends AnyUnit ? QualifiedUnit<TName, N, I[K], keyof InfraProvides<I>> : never;
};

/** Resolve qualification once for the whole published record, preserving property modifiers. */
type PublishRecord<TName extends string, Values> =
  Nested<TName> extends true
    ? { readonly [K in keyof Values as Qualify<TName, K>]: Values[K] }
    : Instanced<TName> extends true
      ? { readonly [K in keyof Values as Qualify<TName, K>]: Values[K] }
      : Values extends unknown
        ? Pick<Readonly<Values>, Extract<keyof Values, string>>
        : never;

/**
 * The feature plugin: needs = the feature's needs + its qualified infra + its
 * children's provides; provides = the public services, `<feature>.usecases`,
 * `<feature>.services` and the slice record `feature.<feature>`.
 */
export type FeatureUnit<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyUnit[],
  C extends readonly AnyDefinedFeature[],
  U,
  P extends ServiceRecord,
  E extends readonly AnyEntrypoint[],
> = Omit<
  Unit<
    WireNeeds<N> & { [K in keyof InfraProvides<I> as Qualify<TName, K>]: InfraProvides<I>[K] } & WireNeeds<
        ChildHandles<C>
      >,
    PublishRecord<TName, ProvidedValues<P>> &
      Readonly<Record<`${TName}.usecases`, UsecaseValues<U>>> &
      Readonly<Record<`${TName}.services`, EntrypointServices<N, U>>> &
      Readonly<Record<`feature.${TName}`, EntrypointPayloads<E>>>,
    // The feature's own needs are the only ones a parent may remap; infra and child keys are already qualified (dotted).
    N,
    TName,
    { readonly open: UsecaseCreationFailure<U>; readonly close: never }
  >,
  'factories' | 'hooks' | 'provides'
> &
  FactoryContract<PublishRecord<TName, ProvidedValues<P>>> & {
    readonly hooks: EmptyShape;
    readonly factories: { readonly [Key in keyof P as PublishKey<TName, Key>]: (ctx: never) => P[Key] };
    readonly provides: UnitHandles<
      TName,
      PublishRecord<TName, ProvidedValues<P>>,
      Readonly<Record<`${TName}.usecases`, UsecaseValues<U>>> &
        Readonly<Record<`${TName}.services`, EntrypointServices<N, U>>> &
        Readonly<Record<`feature.${TName}`, EntrypointPayloads<E>>>
    >;
  };

/**
 * Every handle a request resolves for this feature: its entrypoint-only needs
 * and its usecases. `bind(logic)` hands a request the feature's `<name>.services`
 * record, which holds exactly these, resolved — so the handler sees
 * `context.usecases`, and `context.db` for an `entrypointOnly` `db`.
 */
export type CoreHandles<TName extends string, N extends NeedsShape, U> = EntrypointOnlyNeeds<N> & {
  // The usecases handle is internal: nothing may need it.
  readonly usecases: ScopedHandle<UsecaseValues<U>, `${TName}.usecases`, TName, TName, true>;
};

declare const CoreServicesTag: unique symbol;
declare const EntrypointServicesTag: unique symbol;

/**
 * The feature up to `.usecases()`: name, handles and (type only) the
 * services its entrypoints receive. Entrypoint files take it as a typed
 * parameter (`import type`), so they never import the feature at runtime.
 */
export type FeatureCore<TName extends string, N extends NeedsShape, U> = {
  readonly name: TName;
  readonly handles: CoreHandles<TName, N, U>;
  readonly [CoreServicesTag]?: EntrypointServices<N, U>;
  /** What this stage's `.entrypoints(...)` hand every entrypoint; read it with {@link EntrypointServicesOf}. */
  readonly [EntrypointServicesTag]?: EntrypointServices<N, U>;
};

/** Any feature logic stage — the constraint entrypoint factories take (`schedules(logic, defs)`). */
export type AnyFeatureCore = { readonly name: string; readonly handles: NeedsShape };

/**
 * The services a stage hands its next step — types code declared in another
 * file. Before `.usecases()` it is what a usecase may ask for (needs + infra
 * + children, minus entrypoint-only needs); after, it is what entrypoints get
 * (entrypoint-only needs + `usecases`).
 */
export type DepsOf<C> = C extends { readonly [CoreServicesTag]?: infer D } ? D : never;

/**
 * What the entrypoints of a stage receive, at any stage: the entrypoint-only needs and `usecases`
 * (empty before `.usecases()`). Entrypoint factories in adapter packages (`endpoints(core, build)`,
 * `schedules(core, defs)`) type their handler with it. `DepsOf` is not the same before `.usecases()`:
 * there it is what a usecase may ask for, which entrypoints never receive.
 */
export type EntrypointServicesOf<C> = C extends { readonly [EntrypointServicesTag]?: infer D } ? D : never;

declare const FeatureParamsTag: unique symbol;
/** The type arguments of a finished feature, carried so `instance()` can re-derive a child's type under the new name. */
export type FeatureParams<TName, N, I, C, U, P, E> = {
  readonly name: TName;
  readonly needs: N;
  readonly infra: I;
  readonly children: C;
  readonly usecases: U;
  readonly provides: P;
  readonly entrypoints: E;
};

/** The factories a needs record names through `domainService(fn)`. */
type DomainServiceFns<N> = { [K in keyof N]: N[K] extends { readonly domainService: infer Fn } ? Fn : never }[keyof N];
/** The domain-service factories the children name with `domainService(fn)`, read off each child's needs. */
type ChildDomainNeeds<C extends readonly AnyDefinedFeature[]> = {
  [K in keyof C]: C[K] extends { readonly [FeatureParamsTag]?: infer Params }
    ? Params extends { readonly needs: infer CN }
      ? DomainServiceFns<CN>
      : never
    : never;
}[number];

/** The service type a witness carries. */
type Carried<W> = W extends Service<infer T> ? T : never;
/** `instance(name, rebind)`: a rebound alias takes any handle carrying the same service type — another provider, another key. */
export type RebindOf<N extends NeedsShape> = { readonly [K in keyof N]?: Service<Carried<N[K]>> };
/** The feature's needs after a rebind: a rebound alias takes the new handle's type. */
export type RebindNeeds<N extends NeedsShape, R> = {
  readonly [K in keyof N]: K extends keyof R ? Exclude<R[K], undefined> : N[K];
};
/** Two bound handles name the same service: same provider, same key. An anonymous witness never matches. */
type SameBound<A, B> = A extends { readonly provider: infer O extends string; readonly key: infer K extends string }
  ? B extends { readonly provider: O; readonly key: K }
    ? true
    : false
  : false;
/** The lazy form of a handle (`handle.lazy`), for a child that needs the lazy form of a rebound handle. */
type LazyFormOf<H> = H extends { readonly lazy: infer L } ? L : H;
/** A child's need follows the parent's rebind when it is the same bound handle; a lazy need gets the new lazy form. */
type FollowRebind<W, N, R> = {
  [J in keyof R & keyof N]: SameBound<W, N[J]> extends true
    ? W extends { readonly lazy: true }
      ? LazyFormOf<Exclude<R[J], undefined>>
      : Exclude<R[J], undefined>
    : never;
}[keyof R & keyof N];
/** Pin a rebind result to a witness type; `RebindOf` already guarantees it, the constraint solver needs it spelled. */
type AsWitness<X> = X extends Service<unknown> ? X : never;
type RebindFollowed<CN extends NeedsShape, N, R> = {
  readonly [K in keyof CN]: [FollowRebind<CN[K], N, R>] extends [never] ? CN[K] : AsWitness<FollowRebind<CN[K], N, R>>;
};
/** `reports.compile` under `reports#eu` → `reports#eu.compile`. */
type Reparent<Name extends string, From extends string, To extends string> = Name extends `${From}.${infer Rest}`
  ? `${To}.${Rest}`
  : never;
type InstanceOfChild<F, From extends string, To extends string, N, R> = F extends {
  readonly [FeatureParamsTag]?: FeatureParams<
    infer CName extends string,
    infer CN extends NeedsShape,
    infer CI extends readonly AnyUnit[],
    infer CC extends readonly AnyDefinedFeature[],
    infer CU,
    infer CP extends ServiceRecord,
    infer CE extends readonly AnyEntrypoint[]
  >;
}
  ? DefinedFeature<
      Reparent<CName, From, To>,
      RebindFollowed<CN, N, R>,
      CI,
      InstanceChildren<CC, From, To, N, R>,
      CU,
      CP,
      CE
    >
  : never;
/** The children of an instance: each re-derived under the new parent name, its needs following the rebind. */
export type InstanceChildren<C extends readonly AnyDefinedFeature[], From extends string, To extends string, N, R> = {
  readonly [K in keyof C]: InstanceOfChild<C[K], From, To, N, R>;
};
/** An instance name is one plain segment: no `.` (nesting), `/` (infra unit) or `#` (another instance). */
type InstanceNameGuard<TInstance extends string> = TInstance extends '' | `${string}${'.' | '/' | '#'}${string}`
  ? { readonly 'DOT: an instance name is one plain segment (no ".", "/" or "#")': TInstance }
  : unknown;
/** `#` marks an instance: `defineFeature('reports').instance('eu')`, never `defineFeature('reports#eu')`. */
type FeatureNameGuard<TName extends string> = TName extends `${string}#${string}`
  ? { readonly 'DOT: "#" marks an instance — define the feature without it and call .instance()': TName }
  : unknown;

/** A finished feature: what `.entrypoints(...)` returns and `defineApp().features([...])` mounts. */
export type DefinedFeature<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyUnit[],
  C extends readonly AnyDefinedFeature[],
  U,
  P extends ServiceRecord,
  E extends readonly AnyEntrypoint[],
> = FeatureCore<TName, N, U> & {
  readonly [FeatureParamsTag]?: FeatureParams<TName, N, I, C, U, P, E>;
  /** Public handles, one per provided key — what other features name in their `needs`. Inside a parent they are scoped (`<name>.<key>`). */
  readonly provides: ScopedHandles<ProvidedValues<P>, TName>;
  /** The nested features, as declared. Drivers and `dot explain` walk them. */
  readonly features: C;
  /** Raw infra handles this feature (or a descendant) owns → the owning feature. Checked by `mountFeatures`. */
  readonly owned: ReadonlyMap<object, string>;
  readonly entrypoints: E;
  /** The contract of the `rpc` entrypoint (`never` without one) — `routerFor` matches on it. */
  readonly contract: ContractOf<E>;
  readonly router: RouterOf<E>;
  /** Kernel units in boot order: the qualified infra units, each child's units, then the feature unit. A tuple, so the app builder's guard checks it. */
  units(): UnitsOf<TName, N, I, C, FeatureUnit<TName, N, I, C, U, P, E>>;
  /**
   * Replace infra services by local key before compilation (tests), this
   * feature's (`repos`) or a child's (`'compile.ranker'`). The unit that
   * provides a key is rebuilt in place: same name and needs, the overridden
   * keys return the value, its other keys keep their factory. Its lifecycle
   * hooks are dropped — they were written for the real services.
   * Entrypoints and provides are kept.
   */
  override(values: Partial<InfraProvides<I>> & ChildOverrides<TName, C>): DefinedFeature<TName, N, I, C, U, P, E>;
  /**
   * A second copy of this feature, named `<name>#<instance>`: its own infra
   * units, usecases, services and entrypoints, publishing under
   * `<name>#<instance>.<key>`, so two copies mount side by side. `rebind`
   * swaps a need's handle for another provider's handle of the same service
   * type (`{ db: databaseEu.provides.db }`); a child that needs the same
   * handle follows. The rpc entrypoint gets its own contract identity: the
   * app contract mounts `copy.contract` under its own key.
   */
  instance<const TInstance extends string, const R extends RebindOf<N> = EmptyShape>(
    name: TInstance & InstanceNameGuard<TInstance>,
    rebind?: R,
  ): DefinedFeature<
    `${TName}#${TInstance}`,
    RebindNeeds<N, R>,
    I,
    InstanceChildren<C, TName, `${TName}#${TInstance}`, N, R>,
    U,
    P,
    E
  >;
};

/** The erased finished feature — what the app builder accepts. */
export type AnyDefinedFeature = {
  readonly name: string;
  readonly provides: Readonly<Record<string, AnyHandle>>;
  readonly features: readonly AnyDefinedFeature[];
  readonly entrypoints: readonly AnyEntrypoint[];
  readonly contract: unknown;
  readonly router: unknown;
  /** Raw infra handles this feature (or a descendant) owns → the owning feature. Checked by `mountFeatures`. */
  readonly owned: ReadonlyMap<object, string>;
  units(): readonly AnyUnit[];
};

/* ---- guards: collisions are compile errors at the offending step ---- */

type InfraCollision<N, I extends readonly AnyUnit[]> = keyof InfraProvides<I> & (keyof N | ReservedAlias);
/** What no need resolves to: a type no service satisfies, so the alias is reported. */
type Undeclared = { readonly 'DOT: undeclared need': never };
/** What an infra unit's need alias resolves to inside the feature: a sibling's service, else the feature's need, else nothing. */
type ResolvedInfraNeed<N extends NeedsShape, I extends readonly AnyUnit[], K> = K extends keyof InfraProvides<I>
  ? InfraProvides<I>[K]
  : K extends keyof N
    ? CtxOf<N>[K]
    : Undeclared;
/**
 * The compile-time `sameHandle`: is the unit's bound witness `W` the feature's
 * own handle `Own` (either form, lazy included)? Identity is the `provider` +
 * `key` literal pair. An unbound unit witness (`service<T>()`) passes — the
 * feature's handle is what it gets. A unit that binds a handle where the
 * feature declared none fails, as the runtime does (`ARKI_DOT_E026`). An
 * erased provider (`string`) on either side cannot be compared: the shape
 * check alone decides.
 */
type SameHandle<Own, W> = W extends { readonly provider: infer O extends string; readonly key: infer WK extends string }
  ? Own extends { readonly provider: infer O2 extends string; readonly key: infer WK2 extends string }
    ? string extends O | O2
      ? true
      : [O, WK] extends [O2, WK2]
        ? [O2, WK2] extends [O, WK]
          ? true
          : false
        : false
    : false
  : true;
/**
 * An infra unit's unsatisfied needs when its shape is known — resolved as
 * `qualifyInfra` resolves them: a sibling by the witness's wire key, else the
 * feature's need under the same ALIAS, which must be the same handle (when the
 * unit bound one) and of the needed type.
 */
type UnsatisfiedInfraAliases<N extends NeedsShape, I extends readonly AnyUnit[], S extends NeedsShape> = {
  [A in keyof S]: WireKeyOfNeed<S[A], A> extends keyof InfraProvides<I>
    ? InfraProvides<I>[WireKeyOfNeed<S[A], A>] extends NeedValue<S[A]>
      ? never
      : A
    : A extends keyof N
      ? SameHandle<N[A], S[A]> extends true
        ? CtxOf<N>[A] extends NeedValue<S[A]>
          ? never
          : A
        : A
      : A;
}[keyof S];
/** The service type a witness asks for — what {@link WireNeeds} holds under its wire key (`T | Lazy<T>` for a lazy witness). */
type NeedValue<W> = W extends Service<infer T> ? T : never;
/** The need aliases of the infra units that no sibling and no declared need satisfies (missing, of another type, or bound to another handle). A unit typed without its shape is checked by wire key. */
type UnsatisfiedInfraNeeds<N extends NeedsShape, I extends readonly AnyUnit[]> = {
  [J in keyof I]: I[J] extends AnyUnit
    ? string extends keyof UnitProviderIdentities<I[J]>
      ? {
          [K in keyof UnitNeeds<I[J]>]: ResolvedInfraNeed<N, I, K> extends UnitNeeds<I[J]>[K] ? never : K;
        }[keyof UnitNeeds<I[J]>]
      : UnsatisfiedInfraAliases<N, I, UnitProviderIdentities<I[J]>>
    : never;
}[number];
/**
 * The service keys two infra units both provide. `InfraProvides` intersects
 * the units' records, so `{ repos }` from two units would merge silently;
 * the runtime refuses it (`ARKI_DOT_E027`), so the types do too.
 */
type InfraDup<I extends readonly AnyUnit[], Seen = never> = I extends readonly [
  infer H extends AnyUnit,
  ...infer T extends readonly AnyUnit[],
]
  ? (keyof UnitProvides<H> & Seen) | InfraDup<T, Seen | keyof UnitProvides<H>>
  : never;
type InfraGuard<N extends NeedsShape, I extends readonly AnyUnit[]> = ([InfraCollision<N, I>] extends [never]
  ? unknown
  : { readonly 'DOT: an infra service key collides with a need alias or a reserved name': InfraCollision<N, I> }) &
  ([InfraDup<I>] extends [never] ? unknown : { readonly 'DOT: two infra units provide the same key': InfraDup<I> }) &
  ([UnsatisfiedInfraNeeds<N, I>] extends [never]
    ? unknown
    : {
        readonly 'DOT: an infra unit needs a service the feature does not declare in .needs() (or declares with another type)': UnsatisfiedInfraNeeds<
          N,
          I
        >;
      });

/** `.needs()` takes a record of aliases; a bare handle would be read as a record of its own fields. */
type NotAHandle<N> = N extends { readonly provider: string }
  ? { readonly 'DOT: .needs() takes a record, not a bare handle: .needs({ db: database.provides.db })': never }
  : unknown;

/** The literal entrypoint keys (a descriptor typed with a wide `string` key cannot be checked here; the runtime check covers it). */
type EntrypointKeys<E extends readonly AnyEntrypoint[]> = {
  [I in keyof E]: E[I] extends { readonly key: infer K extends string } ? (string extends K ? never : K) : never;
}[number];
type EntrypointCollision<P, E extends readonly AnyEntrypoint[]> = EntrypointKeys<E> & (keyof P | 'usecases');
type EntrypointGuard<P, E extends readonly AnyEntrypoint[]> = [EntrypointCollision<P, E>] extends [never]
  ? unknown
  : { readonly 'DOT: an entrypoint key collides with a provided service or `usecases`': EntrypointCollision<P, E> };

/* ---- usecases: an object of factories, each checked against the deps ---- */

/** What `.usecases()` takes: one factory per usecase, `(deps) => usecase`. */
export type UsecaseFactories = Readonly<Record<string, (deps: never) => unknown>>;

/**
 * The same, with the feature's deps `D` as the parameter: an inline factory
 * `({ store }) => …` is contextually typed with `D`, so it needs no annotation.
 * An annotated `Pick<D, 'store'>` still fits (parameter contravariance).
 */
export type UsecaseFactoriesOf<D> = Readonly<Record<string, (deps: D) => unknown>>;

/** The usecases object: each factory's return under its key. */
export type Usecases<F extends UsecaseFactories> = { readonly [K in keyof F]: ReturnType<F[K]> };

/** Published values exclude creation refusals and expose only invocation defects. */
export type UsecaseValues<Values> = {
  readonly [Key in keyof Values]: SupervisedUsecase<Exclude<Awaited<Values[Key]>, Failure>>;
};

/** Factory refusals belong to boot, independently of invocation outcomes. */
type UsecaseCreationFailure<Values> = FailureIn<Awaited<Values[keyof Values]>>;

type UnsupportedUsecase<Value> = Value extends (...args: never[]) => infer Result
  ? void extends Awaited<Result>
    ? Value
    : [SupervisedUsecase<Value>] extends [never]
      ? Value
      : never
  : never;
type UnsupportedUsecases<Factories extends UsecaseFactories> = {
  [Key in keyof Factories]: [UnsupportedUsecase<Exclude<Awaited<ReturnType<Factories[Key]>>, Failure>>] extends [never]
    ? never
    : Key;
}[keyof Factories];
type PlainUsecaseCreation =
  | (object & { readonly '~failure'?: never; readonly then?: never })
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;
type CheckedUsecaseCreation<Value> =
  | PlainUsecaseCreation
  | PromiseLike<PlainUsecaseCreation>
  | (void extends Awaited<Value>
      ? { readonly 'DOT: usecase creation must retain concrete outputs instead of void or unknown': never }
      : string extends Extract<Awaited<Value>, Failure>['code']
        ? { readonly 'DOT: usecase creation must retain concrete failure codes instead of broad Failure': never }
        : unknown);
type UsecaseSignatureGuard<Factories extends UsecaseFactories> = ([UnsupportedUsecases<Factories>] extends [never]
  ? unknown
  : {
      readonly 'DOT: usecases need concrete invocation returns, including undefined instead of void; dependent generics and overloads are unsupported': UnsupportedUsecases<Factories>;
    }) & {
  readonly [Key in keyof Factories]: (
    ...args: Parameters<Factories[Key]>
  ) => ReturnType<Factories[Key]> & NoInfer<CheckedUsecaseCreation<ReturnType<Factories[Key]>>>;
};

type DepsAskedBy<Fn> = Fn extends (deps: infer D) => unknown ? D : never;
/**
 * The usecases whose factory asks for deps `D` does not satisfy. A factory that asks for `never`
 * asks for nothing and is never bad: that is the `(deps: never) => unknown` of the constraint, which
 * is what `F` is while TypeScript's first pass over a context-sensitive call (an inline factory whose
 * returned function has an untyped or defaulted parameter) has not inferred `F` yet. Flagging it there
 * rejects the call before the second pass can infer `F` and check the real factories.
 */
type BadUsecases<D, F extends UsecaseFactories> = {
  [K in keyof F]: [DepsAskedBy<F[K]>] extends [never] ? never : [D] extends [DepsAskedBy<F[K]>] ? never : K;
}[keyof F];

/** Names each usecase that asks for a dep the feature does not have, and the deps it lacks. */
export type UsecaseGuard<D, F extends UsecaseFactories> = [BadUsecases<D, F>] extends [never]
  ? unknown
  : {
      readonly 'DOT: a usecase asks for a dep the feature does not provide': {
        readonly [K in BadUsecases<D, F>]: Exclude<keyof DepsAskedBy<F[K]>, keyof D>;
      };
    };

/* ---- domain services: built once per boot, above the children, seen by usecases only ---- */

/** What a domain-service factory builds, as its readers see it: awaited, a `resource()` opened. */
export type DomainServiceValue<Fn extends Factory> = ProvidedValue<Awaited<ReturnType<Fn>>>;

/** The domain services `.domainServices(F)` declares, by key: what the feature's usecases see next to `DomainDeps`. */
export type DomainServiceValues<F extends UsecaseFactories> = { readonly [K in keyof F]: DomainServiceValue<F[K]> };

/**
 * A child's need on a domain service its parent declares, named by the factory: `domainService(extras)`.
 * It is parent-bound: the parent rewires it when it compiles (`remapNeeds`), never the app, so the wiring
 * types (`WireNeeds`, `WireKeyOfNeed`) drop it. Both forms carry `parentBound: true` at runtime too.
 */
export type DomainServiceHandle<Fn extends Factory> = Service<DomainServiceValue<Fn>> & {
  readonly domainService: Fn;
  readonly parentBound: true;
  readonly lazy: LazyService<DomainServiceValue<Fn>> & { readonly domainService: Fn; readonly parentBound: true };
};

type DomainServiceCollision<N, I extends readonly AnyUnit[], F> = keyof F &
  (keyof N | keyof InfraProvides<I> | ReservedAlias);
/** The domain services whose factory may return a Failure. */
type FailingDomainServices<F> = {
  [K in keyof F]: F[K] extends (deps: never) => infer Built
    ? [Extract<Awaited<Built>, Failure>] extends [never]
      ? never
      : K
    : never;
}[keyof F];
/**
 * A domain-service key must not shadow a need alias, an infra key or a reserved name: usecases see all of
 * them by key. A factory must not fail: it builds from deps already built and does no I/O.
 */
export type DomainServicesGuard<N, I extends readonly AnyUnit[], F> = ([DomainServiceCollision<N, I, F>] extends [never]
  ? unknown
  : {
      readonly 'DOT: a domain service key collides with a need alias, an infra service or a reserved name': DomainServiceCollision<
        N,
        I,
        F
      >;
    }) &
  ([FailingDomainServices<F>] extends [never]
    ? unknown
    : {
        readonly 'DOT: a domain service factory cannot fail; a build step that can fail is an adapter: move it to .infra()': FailingDomainServices<F>;
      });

/** Names each domain service whose factory asks for a dep not declared above it, and the deps it lacks. */
type DomainServiceDepsGuard<D, F extends UsecaseFactories> = [BadUsecases<D, F>] extends [never]
  ? unknown
  : {
      readonly 'DOT: a domain service asks for a dep not declared above it (a need or an infra service)': {
        readonly [K in BadUsecases<D, F>]: Exclude<keyof DepsAskedBy<F[K]>, keyof D>;
      };
    };

/* ---- stages: each offers only the later steps ---- */

export type EntrypointsStage<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyUnit[],
  C extends readonly AnyDefinedFeature[],
  U,
  P extends ServiceRecord,
> = FeatureCore<TName, N, U> & {
  /** Finish the feature. Call it with no argument for a feature nothing reaches directly. */
  entrypoints<const E extends readonly Entrypoint<EntrypointServices<N, U> & KernelCtx>[]>(
    ...entrypoints: E & EntrypointGuard<P, E> & ChildContractGuard<C, E>
  ): DefinedFeature<TName, N, I, C, U, P, E>;
};

export type ProvidesStage<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyUnit[],
  C extends readonly AnyDefinedFeature[],
  U,
> = EntrypointsStage<TName, N, I, C, U, EmptyShape> & {
  /** Public services, one factory per key; each gets the usecases only (and the kernel's `$` keys). */
  provides<P extends ServiceRecord & NoReservedKeys & NoKeys<ReservedAlias> = EmptyShape>(
    factories: {
      readonly [K in keyof P]: (services: ProvidesDeps<U> & KernelCtx) => P[K] & NoInfer<CheckedProvider<P[K]>>;
    } & ProvidesGuard<TName, I, P>,
  ): EntrypointsStage<TName, N, I, C, U, P>;
};

export type UsecasesStage<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyUnit[],
  C extends readonly AnyDefinedFeature[],
  S = EmptyShape,
> = Omit<ProvidesStage<TName, N, I, C, EmptyShape>, typeof CoreServicesTag> & {
  /**
   * Before `.usecases()` there are no usecases, so `DepsOf<typeof <feature>Deps>` is
   * exactly what a usecase may ask for — needs + infra + domain services + children, no `usecases` key.
   */
  readonly [CoreServicesTag]?: CoreDeps<N, I, C, S>;
  /**
   * One factory per usecase, built once per boot: `{ signup, markInvited }`,
   * each `(deps) => usecase`. An inline factory gets the deps type for free
   * (`({ repos }) => …`); an annotated one may ask for any subset
   * (`Pick<Deps, 'repos'>`). Asking for a dep the feature lacks is a compile
   * error naming the usecase.
   *
   * Two overloads, on purpose. The first infers inline factories, but a
   * factory that asks for a missing dep fails its constraint with a plain
   * `Property 'mailer' is missing` and never reaches the guard. TypeScript then
   * tries the second, today's signature, whose guard prints the `DOT:` label —
   * and prints the LAST overload's failure under "No overload matches this call".
   */
  usecases<const F extends UsecaseFactoriesOf<CoreDeps<N, I, C, S>>>(
    factories: F & UsecaseSignatureGuard<F>,
  ): ProvidesStage<TName, N, I, C, Usecases<F>>;
  usecases<const F extends UsecaseFactories>(
    factories: F & UsecaseGuard<CoreDeps<N, I, C, S>, F> & UsecaseSignatureGuard<F>,
  ): ProvidesStage<TName, N, I, C, Usecases<F>>;
};

/** `F`: the domain-service factories (children may name them); `S`: their values (usecases see them). */
export type FeaturesStage<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyUnit[],
  F = EmptyShape,
  S = EmptyShape,
> = UsecasesStage<TName, N, I, readonly [], S> & {
  /**
   * The feature's own features, in boot order — each a finished feature
   * named `<this>.<child>`. A child sees this feature's infra (by handle)
   * and its earlier siblings' provides; its provides are seen here and by
   * its siblings, nowhere else.
   */
  features<const C extends readonly AnyDefinedFeature[]>(
    ...children: C & ChildrenGuard<TName, N, I, C, F>
  ): UsecasesStage<TName, N, I, C, S>;
};

export type DomainServicesStage<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyUnit[],
> = FeaturesStage<TName, N, I> & {
  /**
   * The feature's domain services, one plain factory per key, built once per boot before the
   * children: `{ extras }`, each `(deps: Pick<DomainDeps, …>) => value` (a function, an object or a
   * class instance). `DomainDeps` is `DepsOf` of the stage above (needs + infra), so a factory cannot
   * ask for a peer, itself or anything below. A factory cannot fail: it builds from deps already built
   * and does no I/O, so a step that can fail is an adapter and belongs in `.infra()` (a Failure that
   * gets past the types fails boot as a defect). Usecases see each value by key; a child names one with
   * `domainService(fn)`; `provides` and entrypoints never see them.
   *
   * Two overloads, as for `.usecases()`: the first infers inline factories, the second prints the
   * `DOT:` label for a factory that asks for a dep not declared above it.
   */
  domainServices<const F extends UsecaseFactoriesOf<CoreDeps<N, I, readonly []>>>(
    factories: F & DomainServicesGuard<N, I, F>,
  ): FeaturesStage<TName, N, I, F, DomainServiceValues<F>>;
  domainServices<const F extends UsecaseFactories>(
    factories: F & DomainServiceDepsGuard<CoreDeps<N, I, readonly []>, F> & DomainServicesGuard<N, I, F>,
  ): FeaturesStage<TName, N, I, F, DomainServiceValues<F>>;
};

export type InfraStage<TName extends string, N extends NeedsShape> = DomainServicesStage<TName, N, readonly []> & {
  /**
   * The feature's own units, in boot order. Their keys are private to this
   * feature and its children. A unit's need alias is bound to a sibling's
   * key first, then to the feature's need of the same alias; anything else
   * is a compile error naming the alias.
   */
  infra<const I extends readonly AnyUnit[]>(...plugins: I & InfraGuard<N, I>): DomainServicesStage<TName, N, I>;
};

export type NeedsStage<TName extends string> = InfraStage<TName, EmptyShape> & {
  /** What the feature takes from other units, by handle, under local aliases. The one door for handles. */
  needs<N extends NeedsShape & NoReservedKeys & NoKeys<ReservedAlias> = EmptyShape>(
    needs: N & NeedsGuard<TName, N> & NotAHandle<N>,
  ): InfraStage<TName, N>;
};

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

/** An erased factory: the stage types checked it against the services it is called with. */
type Factory = (services: never) => unknown;

/** The chain's steps in order: `.domainServices()` refuses to run after a later one (`ARKI_DOT_E035`). */
const STEP = { needs: 0, infra: 1, domainServices: 2, features: 3, usecases: 4, provides: 5 } as const;

type FeatureState<P extends ServiceRecord = ServiceRecord, U extends ServiceRecord = ServiceRecord> = {
  readonly name: string;
  readonly needs: NeedsShape;
  readonly infra: readonly AnyUnit[];
  /** The `.domainServices()` factories by key; `undefined` until that step runs. */
  readonly domainServices: Readonly<Record<string, Factory>> | undefined;
  /** The last step called (see {@link STEP}). */
  readonly step: (typeof STEP)[keyof typeof STEP];
  readonly children: readonly RuntimeFeature[];
  readonly usecases: { readonly [Key in keyof U]: (services: never) => U[Key] } | undefined;
  readonly provides: { readonly [K in keyof P]: (services: never) => P[K] };
};

/** Recursive copies carry the inferred ownership; raw factory records stay in FeatureState. */
type RuntimeFeature<out Owned extends UnitOwnership = UnitOwnership> = {
  readonly runtime: UnitRuntime<Owned['open'], Owned['close']>;
  readonly name: string;
  readonly handles: NeedsShape;
  readonly provides: Readonly<Record<string, AnyHandle>>;
  readonly features: readonly RuntimeFeature[];
  readonly owned: ReadonlyMap<object, string>;
  readonly entrypoints: readonly AnyEntrypoint[];
  readonly contract: unknown;
  readonly router: unknown;
  units(): readonly AnyUnit[];
  override(values: Readonly<Record<string, unknown>>): RuntimeFeature<Owned>;
  instance(name: string, rebind?: Readonly<Record<string, Service<unknown>>>): RuntimeFeature<Owned>;
  /** Recompile under another name, needs following `follow` (handle → handle). Internal: `instance()` drives it for the children. */
  [REPARENT](name: string, follow: ReadonlyMap<object, Service<unknown>>): RuntimeFeature<Owned>;
  /** The needs as declared, by alias. Internal: a parent's `.features()` checks a child's `domainService(...)` needs. */
  readonly [NEEDS]: NeedsShape;
};

const REPARENT: unique symbol = Symbol('dot.feature.reparent');
const NEEDS: unique symbol = Symbol('dot.feature.needs');

type RuntimeStage<in out P extends ServiceRecord = ServiceRecord, in out U extends ServiceRecord = ServiceRecord> = {
  readonly name: string;
  readonly handles: NeedsShape;
  needs(needs: NeedsShape): RuntimeStage<P, U>;
  infra(...plugins: readonly AnyUnit[]): RuntimeStage<P, U>;
  domainServices(factories: Readonly<Record<string, Factory>>): RuntimeStage<P, U>;
  features(...children: readonly RuntimeFeature[]): RuntimeStage<P, U>;
  usecases<Next extends ServiceRecord>(factories: {
    readonly [Key in keyof Next]: (services: never) => Next[Key];
  }): RuntimeStage<P, Next>;
  provides<Next extends ServiceRecord>(factories: {
    readonly [K in keyof Next]: (services: never) => Next[K];
  }): RuntimeStage<Next, U>;
  entrypoints(
    ...entrypoints: readonly AnyEntrypoint[]
  ): RuntimeFeature<InferredOwnership<P, UsecaseCreationFailure<U>>>;
};

function collision(feature: string, what: string, remediation: string): FeatureError {
  return new FeatureError({
    code: FEATURE_ERROR_CODES.keyCollision,
    message: `[feature] "${feature}": ${what}.`,
    remediation,
  });
}

/** Runtime provenance a witness may carry: a remap or an `entrypointOnly` clone keeps the handle it was written with. */
type Provenance = { readonly origin?: object; readonly lazy?: unknown; readonly entrypointOnly?: boolean };

/** The handle a witness was written with: a remap or an `entrypointOnly` clone keeps it under `origin`. */
const canonical = (w: object): object => (w as Provenance).origin ?? w;

/** The lazy form a handle carries, if any. */
const lazyFormOf = (h: object): unknown => (h as Provenance).lazy;

/** Is `witness` the feature's own handle `own` (either form, lazy included)? */
function sameHandle(witness: object, own: object): boolean {
  const a = canonical(witness);
  const b = canonical(own);
  return a === b || a === lazyFormOf(b) || lazyFormOf(a) === b;
}

/** The wire key a witness names: a token's own key, else the alias (anonymous `service<T>()`). */
function wireKeyOf(witness: Service<unknown>, alias: string): string {
  return 'key' in witness && typeof witness.key === 'string' ? witness.key : alias;
}

/** `digest.compile.rank` → `digest.compile`; a top-level name has no parent. */
function parentOf(name: string): string | undefined {
  const at = name.lastIndexOf('.');
  return at === -1 ? undefined : name.slice(0, at);
}

/**
 * The instance segment of a feature or unit name: `reports#eu`, `reports#eu.audit` and `reports#eu/store` → `eu`;
 * `reports` → `undefined`.
 * Adapters qualify what they register by it (`send-digest#eu`), so a plain feature's names never change.
 */
export function instanceOf(name: string): string | undefined {
  const at = name.indexOf('#');
  if (at === -1) return undefined;
  // The segment ends at the next `.` (a nested child) or `/` (an infra unit, `reports#eu/store`).
  const end = name.slice(at + 1).search(/[./]/);
  return end === -1 ? name.slice(at + 1) : name.slice(at + 1, at + 1 + end);
}

type Ownership = { readonly scope?: string | undefined; readonly internal?: boolean };

/** Mint a handle with explicit ownership; `.lazy` carries the same metadata. */
function scopedHandleOf(
  key: string,
  provider: string,
  scope: string | undefined,
  internal = false,
): Handle<unknown, string> & Ownership & { readonly lazy: Handle<unknown, string>['lazy'] & Ownership } {
  const h = handleOf(key, provider);
  const lazy: Handle<unknown, string>['lazy'] & Ownership = { ...h.lazy, scope, internal };
  return { ...h, scope, internal, lazy };
}

/**
 * Mark a need as entrypoint-only: usecases never receive it; entrypoints and
 * `provides` factories do. The flag survives `.lazy`. The clone keeps the
 * handle it was made from under `origin`, so identity checks (`.infra()`,
 * the child remap, assembly) still see the original.
 */
export function entrypointOnly<H extends AnyHandle & { readonly lazy: object }>(handle: H): EntrypointOnly<H> {
  const lazy = { ...handle.lazy, entrypointOnly: true as const, origin: canonical(handle.lazy) };
  // Erasure seam: the flag and the provenance are added to the handle and its lazy form; the type says the flag only.
  return { ...handle, entrypointOnly: true as const, origin: canonical(handle), lazy } as unknown as EntrypointOnly<H>;
}

/** One witness per factory, so a child's need and its parent's declaration meet by identity. */
const domainServiceWitnesses = new WeakMap<Factory, DomainServiceHandle<Factory>>();

/**
 * Need a domain service the parent feature declares: `needs({ extras: domainService(extras) })` in a
 * child, where `extras` is the factory the parent passes to `.domainServices({ extras })`. The parent
 * binds it to the value it built, once per boot (`domainService(fn).lazy` gives the lazy form). Only a
 * child may need one, and only of a factory its parent declares above `.features()`
 * (`ARKI_DOT_E034` otherwise). The same factory always gives the same witness.
 */
export function domainService<Fn extends Factory>(fn: Fn): DomainServiceHandle<Fn> {
  const known = domainServiceWitnesses.get(fn);
  // Erasure seam: the map is keyed by the factory itself, so the witness stored under `fn` was made for `Fn`.
  if (known !== undefined) return known as DomainServiceHandle<Fn>;
  const made: DomainServiceHandle<Fn> = {
    domainService: fn,
    parentBound: true,
    lazy: { lazy: true, domainService: fn, parentBound: true },
  };
  domainServiceWitnesses.set(fn, made);
  return made;
}

/** The factory a `domainService(fn)` witness names, or `undefined` for any other witness. */
const domainServiceIn = (witness: object): unknown => ('domainService' in witness ? witness.domainService : undefined);

/** A feature and every descendant, depth-first in declaration order — what drivers and `dot explain` walk. Each node once. */
export function allFeatures(features: readonly AnyDefinedFeature[]): readonly AnyDefinedFeature[] {
  return features.flatMap(f => [f, ...allFeatures(f.features)]);
}

/** A node's OWN kernel units — its qualified infra and its feature unit — never a descendant's. Adapters read declarations from these. */
export function ownUnits(feature: AnyDefinedFeature): readonly AnyUnit[] {
  return feature.units().filter(u => u.name === feature.name || u.name.startsWith(`${feature.name}/`));
}

/** `H` with its ownership stripped: the same handle, public. */
type PublicHandle<H> =
  H extends Handle<infer T, infer K extends string, infer O extends string> ? Handle<T, K, O> : never;
/** The `<name>.services` handles among a unit list's provides, public. */
type ServicesHandlesIn<Units> = Units extends readonly (infer U)[]
  ? U extends { readonly provides: infer P }
    ? { readonly [K in keyof P & `${string}.services`]: PublicHandle<P[K]> }
    : never
  : never;
/** What a gateway needs to serve these features' requests: their public handles, and every node's `<name>.services`. */
export type RequestHandles<T extends readonly AnyDefinedFeature[]> = UnionToIntersection<T[number]['provides']> &
  UnionToIntersection<ServicesHandlesIn<ReturnType<T[number]['units']>>>;

/**
 * The handles a gateway needs to serve requests for these features, as one
 * `provides` record: the top-level features' public handles, and the
 * `<name>.services` bag of every node (nested children included), which
 * `bind(core)` reads per request. The bags are published public here on
 * purpose — serving requests is the assembly's job, not a feature's — so a
 * gateway may spread them into its needs. The gateway is a driving adapter,
 * not a feature (a feature's `provides` sees only its usecases), mounted with
 * the app's `.entrypoints(gateway)`:
 *
 * ```ts
 * const units = [...legacy, requestServices(converted)];
 * entrypoint({ name: 'gateway', needs: { ...providesOf(units) }, provides: { rpc: ctx => servicesOf(ctx, units) … } })
 * ```
 */
export function requestServices<const T extends readonly AnyDefinedFeature[]>(
  features: T,
): { readonly provides: RequestHandles<T> } {
  const provides: Record<string, AnyHandle> = {};
  for (const f of features) Object.assign(provides, f.provides);
  for (const node of allFeatures(features))
    provides[`${node.name}.services`] = handleOf(`${node.name}.services`, node.name);
  // Erasure seam: built key by key at runtime; the type is read off the features' own units.
  return { provides: provides as RequestHandles<T> };
}

function within(feature: string, scope: string): boolean {
  return feature === scope || feature.startsWith(`${scope}.`);
}

/** Why `feature` may not need `witness`, or `undefined` when it may. Reads the handle's own metadata, nothing derived. */
function unreachable(feature: string, witness: Ownership): string | undefined {
  if (witness.internal === true) return 'an internal handle (usecases/services); need its provides instead';
  if (typeof witness.scope === 'string' && !within(feature, witness.scope)) return `private to "${witness.scope}"`;
  return undefined;
}

/**
 * Assemble features for an app: the normalized node list (each node once, depth-first)
 * and the kernel units. Checks raw-handle ownership before anything binds by key: a unit
 * outside a feature's scope that still holds one of its raw infra handles is refused —
 * the remap at `.features()` has replaced every legitimate one, so only outsiders keep them.
 * `defineApp().features()` runs this; drivers and driven adapters read `features` from it.
 *
 * @throws {FeatureError} `ARKI_DOT_E026` naming the unit, the alias and the owning feature.
 */
export function mountFeatures(features: readonly AnyDefinedFeature[]): {
  readonly features: readonly AnyDefinedFeature[];
  readonly units: readonly AnyUnit[];
} {
  const nodes = allFeatures(features);
  // A feature and its instances share the same infra unit objects, so one raw handle may have several owners.
  const owned = new Map<object, Set<string>>();
  for (const f of nodes) {
    for (const [handle, scope] of f.owned) {
      const scopes = owned.get(handle) ?? new Set<string>();
      scopes.add(scope);
      owned.set(handle, scopes);
    }
  }
  const units = features.flatMap(f => f.units());
  for (const unit of units) {
    const feature = unit.name.split('/')[0] ?? unit.name;
    for (const [alias, witness] of Object.entries(unit.needs)) {
      // Only a parent binds `domainService(fn)` (it rewires the need when it compiles); one still raw here
      // belongs to a child mounted without its parent, and must not bind by alias to whatever publishes the key.
      if (domainServiceIn(witness) !== undefined) {
        throw new FeatureError({
          code: FEATURE_ERROR_CODES.domainServiceNotAbove,
          message: `[feature] "${unit.name}": need "${alias}" is domainService(...), which only the parent feature binds, but "${feature}" is mounted without its parent.`,
          remediation: `Mount the parent feature "${parentOf(feature) ?? feature}"; it mounts this child with .features().`,
        });
      }
      // A remapped need (or an entrypointOnly clone) keeps the handle it was written with under `origin`.
      const scopes = owned.get(canonical(witness));
      if (scopes !== undefined && ![...scopes].some(owner => within(feature, owner))) {
        const scope = [...scopes].join('", "');
        throw new FeatureError({
          code: FEATURE_ERROR_CODES.missingCapability,
          message: `[feature] "${unit.name}": need "${alias}" is a raw infra handle of "${scope}" (private); it would otherwise bind to whatever publishes "${wireKeyOf(witness, alias)}".`,
          remediation: `Need a public handle, or have "${scope}" re-export the service with provides().`,
        });
      }
    }
  }
  return { features: nodes, units };
}

type Remap = { readonly key: string; readonly unit: string; readonly scope: string };

/**
 * Rewrite a child unit's needs that name THIS feature's infra handles — matched by
 * handle identity (the object the child wrote, its lazy form, or an `entrypointOnly`
 * clone of either), never by key, so a same-key handle of another store is left as
 * it is for `mountFeatures` to refuse. The remapped handle keeps the original under
 * `origin` and the entrypoint-only flag.
 */
function remapNeeds(unit: AnyUnit, ownedInfra: ReadonlyMap<object, Remap>): AnyUnit {
  const needs: Record<string, Service<unknown>> = {};
  let touched = false;
  for (const [alias, witness] of Object.entries(unit.needs)) {
    const original = canonical(witness);
    const target = ownedInfra.get(original);
    if (target === undefined) {
      needs[alias] = witness;
      continue;
    }
    const handle = scopedHandleOf(target.key, target.unit, target.scope);
    const flag = (witness as Provenance).entrypointOnly === true ? { entrypointOnly: true as const } : {};
    // Provenance: the handle the child wrote stays attached, so assembly can validate the original owner.
    const remapped: Service<unknown> & Provenance = isLazyWitness(witness)
      ? { ...handle.lazy, ...flag, origin: original }
      : { ...handle, ...flag, origin: original };
    needs[alias] = remapped;
    touched = true;
  }
  return touched ? { ...unit, needs } : unit;
}

/** The children's public handles, merged by local key. */
function childHandles(children: readonly RuntimeFeature[]): Record<string, AnyHandle> {
  return Object.assign({}, ...children.map(c => c.provides));
}

/**
 * Qualify every infra plugin: keys → `<feature>.<key>`, names → `<feature>/<unit>`,
 * sibling needs → the qualified key, every other need alias → the feature's own handle.
 */
function qualifyInfra(
  feature: string,
  declared: NeedsShape,
  infra: readonly AnyUnit[],
): { readonly units: readonly AnyUnit[]; readonly handles: Readonly<Record<string, AnyHandle>> } {
  const unitByKey = new Map<string, string>();
  for (const p of infra) for (const key of Object.keys(p.provides)) unitByKey.set(key, `${feature}/${p.name}`);

  const handles: Record<string, AnyHandle> = {};
  const units = infra.map((p): AnyUnit => {
    const unitName = `${feature}/${p.name}`;
    const qualified: Record<string, string> = {};
    for (const key of Object.keys(p.provides)) {
      qualified[key] = `${feature}.${key}`;
      handles[key] = scopedHandleOf(`${feature}.${key}`, unitName, feature);
    }
    const needs: Record<string, Service<unknown>> = {};
    for (const [alias, witness] of Object.entries(p.needs)) {
      const key = wireKeyOf(witness, alias);
      const sibling = unitByKey.get(key);
      if (sibling === undefined) {
        // Not a sibling: the feature's own need under this alias (`.infra()` proved it exists). A lazy witness takes the lazy form.
        const own = declared[alias] ?? witness;
        needs[alias] =
          isLazyWitness(witness) && !isLazyWitness(own)
            ? (((own as Provenance).lazy as Service<unknown> | undefined) ?? own)
            : own;
        continue;
      }
      // The sibling's key is qualified now; the need follows it (a lazy witness stays lazy).
      const handle = handleOf(`${feature}.${key}`, sibling);
      needs[alias] = isLazyWitness(witness) ? handle.lazy : handle;
    }
    const renamed = rename(p, qualified, unitName);
    // The unit's own handles carry ownership too, so `units()[i].provides[k]` is refused outside the feature.
    const provides = Object.fromEntries(
      Object.keys(renamed.provides).map(key => [key, scopedHandleOf(key, unitName, feature)]),
    );
    return { ...renamed, needs, provides };
  });
  return { units, handles };
}

/** Rebuild one infra unit with some services replaced; untouched units are returned as they are. */
function replaceServices(p: AnyUnit, values: Readonly<Record<string, unknown>>, used: Set<string>): AnyUnit {
  const factories: Record<string, Factory> = { ...p.factories };
  let touched = false;
  for (const key of Object.keys(p.provides)) {
    if (!(key in values)) continue;
    // `factories` is keyed by publish key; `provides` by wire key (they differ after a rename()).
    const local = Object.entries(p.renames).find(([, wire]) => wire === key)?.[0] ?? key;
    const value = values[key];
    factories[local] = () => value;
    used.add(key);
    touched = true;
  }
  return touched ? { ...p, factories, runtime: createUnitRuntime(), hooks: {} } : p;
}

function checkEntrypoints(state: FeatureState, entrypoints: readonly AnyEntrypoint[]): void {
  const seen = new Set<string>();
  for (const e of entrypoints) {
    if (seen.has(e.key)) {
      throw new FeatureError({
        code: FEATURE_ERROR_CODES.duplicateSliceKey,
        message: `[feature] "${state.name}" declares two "${e.key}" entrypoints; the second would silently replace the first.`,
        remediation: `Merge the two "${e.key}" entrypoints into one, or move one into its own feature.`,
      });
    }
    seen.add(e.key);
    if (e.key in state.provides || e.key === 'usecases') {
      throw collision(
        state.name,
        `entrypoint "${e.key}" collides with a provided service`,
        'Rename the provided service; entrypoint keys are fixed by their adapter.',
      );
    }
  }
}

function checkChildContracts(state: FeatureState, entrypoints: readonly AnyEntrypoint[]): void {
  const rpc = entrypoints.find(e => e.kind === 'rpc');
  // By router identity: `rpc(contract, implementer, () => ({ compile: compile.router }))` keeps the child's router object as it is.
  const mounted = new Set<unknown>(rpc !== undefined && 'router' in rpc ? Object.values(rpc.router as object) : []);
  for (const child of state.children) {
    if (child.contract !== undefined && !mounted.has(child.router)) {
      throw new FeatureError({
        code: FEATURE_ERROR_CODES.contractNotMounted,
        message: `[feature] "${state.name}": the rpc contract of its child "${child.name}" is not mounted in its own contract.`,
        remediation: `Add the child's contract under a key of "${state.name}"'s contract and its router under the same key in rpc(...).`,
      });
    }
  }
}

/** Wraps one built value under its key before anything reads it. */
type WrapBuilt = (feature: string, key: string, value: unknown) => unknown;

/** A usecase is supervised, then traced. A domain service is traced only (`traceUsecase`: a function gets a span, any other value passes as is). */
const wrapUsecase: WrapBuilt = (feature, key, value) => traceUsecase(feature, key, superviseUsecase(value));

/**
 * Keep creation failures typed while the kernel owns and joins asynchronous preparation. Builds the
 * usecases, and the domain services too: each under the reserved `usecases` slot of the unit's context,
 * which no need alias or infra key may take.
 */
async function prepareUsecases<Values extends ServiceRecord>(
  feature: string,
  factories: { readonly [Key in keyof Values]: (deps: never) => Values[Key] } | undefined,
  deps: never,
  wrap: WrapBuilt,
): Promise<{ usecases: Record<string, unknown> } | UsecaseCreationFailure<Values>> {
  const usecases: Record<string, unknown> = {};
  for (const key in factories) {
    const create: (deps: never) => Values[keyof Values] = factories[key];
    // Each factory gets its own frozen copy, so one factory cannot change what the next one sees.
    const ownDeps: never = Object.freeze({ ...(deps as object) }) as never;
    const created = await Promise.resolve(create(ownDeps));
    if (creationFailed(created)) return created;
    usecases[key] = wrap(feature, key, created);
  }
  return { usecases };
}

/**
 * Build the domain services. The types refuse a factory that can fail (`DomainServicesGuard`); one that
 * fails anyway, past erased types, fails boot as a defect: no reader's type expects that Failure.
 */
async function prepareDomainServices(
  feature: string,
  factories: Readonly<Record<string, Factory>>,
  deps: never,
): Promise<BuiltDomainServices | Failure> {
  const built = await prepareUsecases(feature, factories, deps, traceUsecase);
  return creationFailed(built) ? UnexpectedDefect({ cause: built }) : built;
}

/** The context a domain-service unit's factories read: what `prepareUsecases` built, by local key. */
type BuiltDomainServices = { readonly usecases: Readonly<Record<string, unknown>> };

function creationFailed<Value>(value: Value): value is FailureIn<Value> {
  return isFailure<unknown>(value);
}

function compile<P extends ServiceRecord, U extends ServiceRecord>(
  state: FeatureState<P, U>,
  infra: ReturnType<typeof qualifyInfra>,
  handles: NeedsShape,
  entrypoints: readonly AnyEntrypoint[],
): RuntimeFeature<InferredOwnership<P, UsecaseCreationFailure<U>>> {
  checkEntrypoints(state, entrypoints);
  checkChildContracts(state, entrypoints);
  const usecasesKey = `${state.name}.usecases`;
  const servicesKey = `${state.name}.services`;
  const sliceKey = `feature.${state.name}`;
  const nested = parentOf(state.name) !== undefined;
  const instanced = state.name.includes('#');
  const domainServices = state.domainServices ?? {};
  const domainUnitName = `${state.name}/domain-services`;
  // Each domain service under its local key, published as `<name>.<key>` and private to this feature and its children.
  const domainHandles: Record<string, Handle<unknown, string>> = {};
  for (const key of Object.keys(domainServices))
    domainHandles[key] = scopedHandleOf(`${state.name}.${key}`, domainUnitName, state.name);
  // Inside a parent a provided key is scoped: `digest.compile.compiler`; an instance qualifies too
  // (`reports#eu.summary`), so two copies mount side by side. At the top level it is public and bare.
  const publishKey = (key: string): string => (nested || instanced ? `${state.name}.${key}` : key);
  // This feature's raw infra handles (and their lazy forms) → where they live now (`digest.repos`, unit `digest/store`).
  const ownedInfra = new Map<object, Remap>();
  for (const p of state.infra) {
    for (const [key, h] of Object.entries(p.provides)) {
      const target: Remap = { key: `${state.name}.${key}`, unit: `${state.name}/${p.name}`, scope: state.name };
      ownedInfra.set(h, target);
      ownedInfra.set(h.lazy, target);
    }
  }
  // A child's `domainService(fn)` (either form) → this feature's domain-service unit, rewired like an infra handle.
  for (const [key, fn] of Object.entries(domainServices)) {
    const witness = domainService(fn);
    const target: Remap = { key: `${state.name}.${key}`, unit: domainUnitName, scope: state.name };
    ownedInfra.set(witness, target);
    ownedInfra.set(witness.lazy, target);
  }
  // Entrypoint-only needs: in the unit's needs (boot order, explain), out of the usecases' deps.
  const doorKeys = new Set(Object.keys(entrypointOnlyNeeds(state.needs)));

  // Preparation enriches the owned kernel context once before any provider can run.
  const usecasesOf = (ctx: object): unknown => ('usecases' in ctx ? ctx.usecases : undefined);
  // The exits: `provides` factories get the usecases; entrypoints get the entrypoint-only needs and the
  // usecases. Both keep the kernel's `$` keys. Infra, plain needs, children and domain services stay below.
  const kernelOf = (ctx: object): object => Object.fromEntries(Object.entries(ctx).filter(([k]) => k.startsWith('$')));
  const providesDepsOf = (ctx: object): object => Object.freeze({ ...kernelOf(ctx), usecases: usecasesOf(ctx) });
  const servicesOf = (ctx: object): object => ({
    ...Object.fromEntries(Object.entries(ctx).filter(([k]) => doorKeys.has(k) || k.startsWith('$'))),
    usecases: usecasesOf(ctx),
  });

  const factories: Record<string, (ctx: object) => unknown> = {
    [usecasesKey]: usecasesOf,
    // The resolved services (entrypoint-only needs + usecases, by local key) — what `bind(logic)` hands a request.
    // One key per feature, read by the feature's own name: no per-handle resolution, so a remapped need just works.
    // The kernel's `$` keys stay out: a handler context carries the feature's services, not the kernel's.
    // The one exception is `$handlers`: transport adapters read it to emit handler events, then strip it.
    [servicesKey]: ctx =>
      Object.fromEntries(Object.entries(servicesOf(ctx)).filter(([k]) => !k.startsWith('$') || k === HANDLERS_KEY)),
    // One record under `feature.<name>`, keyed by entrypoint key — what `sliceOf` reads.
    [sliceKey]: ctx => {
      const services = servicesOf(ctx);
      // Erasure seam: each entrypoint was typed against these services by `.entrypoints()`.
      return Object.fromEntries(entrypoints.map(e => [e.key, e.resolve(services as never)]));
    },
  };
  for (const [key, factory] of Object.entries(state.provides)) {
    // Erasure seam: each factory was typed against these services by `.provides()`.
    factories[publishKey(key)] = ctx => factory(providesDepsOf(ctx));
  }

  // The unit's published handles keep ownership too: provides scoped to the parent, generated keys internal.
  const unitHandles: Record<string, Handle<unknown, string>> = {};
  for (const key of Object.keys(factories)) {
    const generated = key === usecasesKey || key === servicesKey || key === sliceKey;
    unitHandles[key] = scopedHandleOf(key, state.name, generated ? state.name : parentOf(state.name), generated);
  }
  const runtime = createUnitRuntime<Awaited<ReturnType<typeof prepareUsecases<U>>>>(undefined, ctx =>
    prepareUsecases(
      state.name,
      state.usecases,
      Object.fromEntries(Object.entries(ctx).filter(([key]) => !doorKeys.has(key))) as never,
      wrapUsecase,
    ),
  );
  // The domain services: one unit, built once per boot after the infra and before the children, from the
  // usecase-visible needs and the infra. Functions are traced, nothing is supervised.
  const domainUnit: AnyUnit | undefined =
    state.domainServices === undefined
      ? undefined
      : {
          runtime: createUnitRuntime<BuiltDomainServices | Failure>(undefined, ctx =>
            prepareDomainServices(state.name, domainServices, ctx),
          ),
          name: domainUnitName,
          needs: {
            ...Object.fromEntries(Object.entries(state.needs).filter(([key]) => !doorKeys.has(key))),
            ...infra.handles,
          },
          actions: [],
          renames: {},
          role: 'domain-service',
          provides: Object.fromEntries(Object.values(domainHandles).map(h => [h.key, h])),
          factories: Object.fromEntries(
            Object.entries(domainHandles).map(([key, h]) => [h.key, (ctx: BuiltDomainServices) => ctx.usecases[key]]),
          ),
          hooks: {},
        };
  // The record infra() builds, written out: the needs here are already handles, and the keys already wire keys.
  const unit: AnyUnit = {
    runtime,
    name: state.name,
    needs: { ...state.needs, ...infra.handles, ...domainHandles, ...childHandles(state.children) },
    actions: entrypoints.flatMap(e => [...e.actions, ...(e.actionsOf?.(state.name, state.children) ?? [])]),
    renames: {},
    role: 'feature',
    provides: unitHandles,
    factories,
    hooks: {},
  };
  // Boot order: this feature's infra, its domain services, then each child (its own units, any depth), then this feature.
  const units: readonly AnyUnit[] = [
    ...infra.units,
    ...(domainUnit === undefined ? [] : [domainUnit]),
    ...state.children.flatMap(c => c.units().map(u => remapNeeds(u, ownedInfra))),
    unit,
  ];

  const provides: Record<string, AnyHandle> = {};
  for (const key of Object.keys(state.provides))
    provides[key] = scopedHandleOf(publishKey(key), state.name, parentOf(state.name));
  // Raw infra handles this feature owns (and its descendants'): what `mountFeatures` refuses to outsiders.
  const owned = new Map<object, string>(state.children.flatMap(c => [...c.owned]));
  for (const p of state.infra) {
    for (const h of Object.values(p.provides)) {
      owned.set(h, state.name);
      owned.set(h.lazy, state.name);
    }
  }
  for (const fn of Object.values(domainServices)) {
    const witness = domainService(fn);
    owned.set(witness, state.name);
    owned.set(witness.lazy, state.name);
  }
  const rpc = entrypoints.find(e => e.kind === 'rpc');

  // A copy under another name: needs follow the rebind, children are re-derived under the new parent,
  // everything else is recompiled from the same declarations. Only the root copy gets its own rpc
  // contract identity — a parent's router holds its children's routers by identity.
  const reparent = (
    name: string,
    follow: ReadonlyMap<object, Service<unknown>>,
    root: boolean,
  ): RuntimeFeature<InferredOwnership<P, UsecaseCreationFailure<U>>> => {
    const needs = Object.fromEntries(Object.entries(state.needs).map(([alias, w]) => [alias, followRebind(w, follow)]));
    const children = state.children.map(c => c[REPARENT](`${name}.${c.name.slice(state.name.length + 1)}`, follow));
    const next: FeatureState<P, U> = { ...state, name, needs, children };
    const nextInfra = qualifyInfra(name, needs, next.infra);
    return compile(next, nextInfra, handlesOf(next), root ? ownContract(entrypoints) : entrypoints);
  };

  return {
    runtime,
    name: state.name,
    handles,
    provides,
    features: state.children,
    owned,
    entrypoints,
    contract: rpc !== undefined && 'contract' in rpc ? rpc.contract : undefined,
    router: rpc !== undefined && 'router' in rpc ? rpc.router : undefined,
    units: () => units,
    override: values => {
      // `compile.ranker` → the child named `<this>.compile`, override `ranker` there (recursive by construction).
      const own: Record<string, unknown> = {};
      const forChild = new Map<string, Record<string, unknown>>();
      for (const [key, value] of Object.entries(values)) {
        const dot = key.indexOf('.');
        if (dot === -1) {
          own[key] = value;
          continue;
        }
        const local = key.slice(0, dot);
        const sub = forChild.get(local) ?? {};
        sub[key.slice(dot + 1)] = value;
        forChild.set(local, sub);
      }
      const used = new Set<string>();
      const replaced = state.infra.map(p => replaceServices(p, own, used));
      for (const key of Object.keys(own)) {
        if (!used.has(key)) {
          throw new FeatureError({
            code: FEATURE_ERROR_CODES.unknownOverride,
            message: `[feature] "${state.name}": override("${key}") names no service of its infra units.`,
            remediation: `Override one of: ${state.infra.flatMap(p => Object.keys(p.provides)).join(', ') || '(no infra)'}.`,
          });
        }
      }
      for (const local of forChild.keys()) {
        if (!state.children.some(c => c.name === `${state.name}.${local}`)) {
          throw new FeatureError({
            code: FEATURE_ERROR_CODES.unknownOverride,
            message: `[feature] "${state.name}": override("${local}.…") names no child feature.`,
            remediation: `Children: ${state.children.map(c => c.name).join(', ') || '(none)'}.`,
          });
        }
      }
      const children = state.children.map(c => {
        const sub = forChild.get(c.name.slice(state.name.length + 1));
        return sub === undefined ? c : c.override(sub);
      });
      const next = { ...state, infra: replaced, children };
      return compile(next, qualifyInfra(next.name, next.needs, next.infra), handles, entrypoints);
    },
    instance: (suffix, rebind = {}) => {
      if (suffix === '' || /[./#]/.test(suffix)) {
        throw new FeatureError({
          code: FEATURE_ERROR_CODES.keyCollision,
          message: `[feature] "${state.name}": instance name "${suffix}" is not one plain segment.`,
          remediation:
            'Letters, digits and dashes only: .instance("eu"). "." nests, "/" marks an infra unit, "#" an instance.',
        });
      }
      const follow = new Map<object, Service<unknown>>();
      for (const [alias, next] of Object.entries(rebind)) {
        const own = state.needs[alias];
        if (own === undefined) {
          throw new FeatureError({
            code: FEATURE_ERROR_CODES.unknownOverride,
            message: `[feature] "${state.name}": instance("${suffix}") rebinds "${alias}", which is not a need.`,
            remediation: `Needs: ${Object.keys(state.needs).join(', ') || '(none)'}.`,
          });
        }
        follow.set(canonical(own), next);
      }
      return reparent(`${state.name}#${suffix}`, follow, true);
    },
    [REPARENT]: (name, follow) => reparent(name, follow, false),
    [NEEDS]: state.needs,
  };
}

/** The rebound handle with the flag `entrypointOnly(...)` sets, on it and on its lazy form; the clone keeps the handle under `origin`. */
function markEntrypointOnly(handle: Service<unknown>): Service<unknown> {
  const lazy = lazyFormOf(handle);
  const flag = (w: object) => ({ entrypointOnly: true, origin: canonical(w) });
  const lazyFlagged = typeof lazy === 'object' && lazy !== null ? { lazy: Object.assign({}, lazy, flag(lazy)) } : {};
  return Object.assign({}, handle, flag(handle), lazyFlagged);
}

/** The witness after a rebind: the rebound handle (its lazy form for a lazy need), else the witness as written. */
function followRebind(witness: Service<unknown>, follow: ReadonlyMap<object, Service<unknown>>): Service<unknown> {
  const base = canonical(witness);
  const direct = follow.get(base);
  if (direct !== undefined) return keepEntrypointOnly(witness, direct);
  for (const [from, to] of follow) {
    if (lazyFormOf(from) !== base) continue;
    const lazy = lazyFormOf(to);
    return keepEntrypointOnly(witness, typeof lazy === 'object' && lazy !== null ? lazy : to);
  }
  return witness;
}

/**
 * A rebound `entrypointOnly` need stays entrypoint-only, in either form: the flag belongs to the
 * alias, not to the old handle, so a rebind that drops it would hand a usecase the entrypoint's db.
 */
function keepEntrypointOnly(witness: Service<unknown>, rebound: Service<unknown>): Service<unknown> {
  const flagged = (witness as Provenance).entrypointOnly === true && (rebound as Provenance).entrypointOnly !== true;
  return flagged ? markEntrypointOnly(rebound) : rebound;
}

/**
 * The rpc entrypoint with its own contract and router records: `routerFor`
 * finds a feature by contract identity, so a copy needs its own. The
 * procedures inside are shared; a child's router stays the same object, so
 * the parent's mount check still finds it.
 */
function ownContract(entrypoints: readonly AnyEntrypoint[]): readonly AnyEntrypoint[] {
  return entrypoints.map(e => {
    if (e.kind !== 'rpc' || !('contract' in e) || !('router' in e)) return e;
    const router: object = { ...(e.router as object) };
    return { ...e, contract: { ...(e.contract as object) }, router, resolve: () => router };
  });
}

/** The handles a feature's entrypoints and `bind(logic)` see: entrypoint-only needs and usecases. */
function handlesOf(state: FeatureState): NeedsShape {
  return {
    ...entrypointOnlyNeeds(state.needs),
    usecases: scopedHandleOf(`${state.name}.usecases`, state.name, state.name, true),
  };
}

/** The needs declared with `entrypointOnly(...)`: the only needs that pass the usecases to the exits. */
function entrypointOnlyNeeds(needs: NeedsShape): NeedsShape {
  return Object.fromEntries(Object.entries(needs).filter(([, w]) => (w as Provenance).entrypointOnly === true));
}

function stage<P extends ServiceRecord, U extends ServiceRecord>(state: FeatureState<P, U>): RuntimeStage<P, U> {
  const infra = qualifyInfra(state.name, state.needs, state.infra);
  const handles = handlesOf(state);
  return {
    name: state.name,
    handles,
    needs: needs => {
      if ('provider' in needs && typeof needs.provider === 'string' && 'key' in needs) {
        throw collision(
          state.name,
          'needs() takes a record of aliases, not a bare handle',
          'Write .needs({ db: database.provides.db }) — the alias is the name usecases and entrypoints see.',
        );
      }
      for (const [alias, witness] of Object.entries(needs)) {
        if (RESERVED.has(alias)) {
          throw collision(state.name, `need alias "${alias}" is reserved`, 'Pick another alias for this need.');
        }
        const why = unreachable(state.name, witness as Ownership);
        if (why !== undefined) {
          throw new FeatureError({
            code: FEATURE_ERROR_CODES.missingCapability,
            message: `[feature] "${state.name}": need "${alias}" reaches "${wireKeyOf(witness, alias)}", ${why}.`,
            remediation: 'Need a public handle, or have the owning feature re-export the service with provides().',
          });
        }
        if (parentOf(state.name) === undefined && domainServiceIn(witness) !== undefined) {
          throw new FeatureError({
            code: FEATURE_ERROR_CODES.domainServiceNotAbove,
            message: `[feature] "${state.name}": need "${alias}" is domainService(...), which names a parent's domain service; a top-level feature has no parent.`,
            remediation:
              "Declare the factory in this feature's own .domainServices({ … }) and read it in the usecases by key, or need a public handle.",
          });
        }
      }
      return stage({ ...state, needs, step: STEP.needs });
    },
    features: (...children) => {
      const seen = new Map<string, string>(
        [
          ...Object.keys(state.needs),
          ...state.infra.flatMap(p => Object.keys(p.provides)),
          ...Object.keys(state.domainServices ?? {}),
        ].map(k => [k, state.name]),
      );
      const declared = new Set<unknown>(Object.values(state.domainServices ?? {}));
      for (const child of children) {
        if (parentOf(child.name) !== state.name) {
          throw new FeatureError({
            code: FEATURE_ERROR_CODES.keyCollision,
            message: `[feature] "${state.name}": child "${child.name}" is not named "${state.name}.<child>".`,
            remediation: `Name the child "${state.name}.${child.name.split('.').at(-1)}" (its folder sits under this feature's).`,
          });
        }
        for (const [alias, witness] of Object.entries(child[NEEDS])) {
          const fn = domainServiceIn(witness);
          if (fn === undefined || declared.has(fn)) continue;
          throw new FeatureError({
            code: FEATURE_ERROR_CODES.domainServiceNotAbove,
            message: `[feature] "${state.name}": child "${child.name}" needs "${alias}" through domainService(...), but "${state.name}" does not declare that factory above .features().`,
            remediation: `Pass the factory to "${state.name}".domainServices({ … }) before .features(); the child names the same function.`,
          });
        }
        for (const key of Object.keys(child.provides)) {
          const owner = seen.get(key);
          if (RESERVED.has(key) || owner !== undefined) {
            throw collision(
              state.name,
              `child "${child.name}" provides "${key}", which collides with ${owner === state.name ? 'a need alias or an infra service or a domain service' : `a service of "${owner}"`}`,
              'Rename one of the two; inside a feature one key means one thing.',
            );
          }
          seen.set(key, child.name);
        }
      }
      return stage({ ...state, children, step: STEP.features });
    },
    infra: (...units) => {
      const seen = new Set<string>();
      for (const key of units.flatMap(p => Object.keys(p.provides))) {
        if (RESERVED.has(key) || key in state.needs || seen.has(key)) {
          throw collision(
            state.name,
            `infra service "${key}" collides with a need alias, another infra service or a reserved name`,
            'Give one of them another key with rename(), or another need alias.',
          );
        }
        seen.add(key);
      }
      const siblingKeys = new Set(units.flatMap(p => Object.keys(p.provides)));
      for (const p of units) {
        for (const [alias, witness] of Object.entries(p.needs)) {
          if (siblingKeys.has(wireKeyOf(witness, alias))) continue;
          const own = state.needs[alias];
          if (own === undefined) {
            throw new FeatureError({
              code: FEATURE_ERROR_CODES.missingCapability,
              message: `[feature] "${state.name}": infra unit "${p.name}" needs "${alias}", which the feature does not declare.`,
              remediation: `Add it to .needs({ ${alias}: … }); the feature's handle is what the unit gets.`,
            });
          }
          if ('key' in witness && !sameHandle(witness, own)) {
            throw new FeatureError({
              code: FEATURE_ERROR_CODES.missingCapability,
              message: `[feature] "${state.name}": infra unit "${p.name}" binds "${alias}" to a handle other than the feature's.`,
              remediation: 'Declare the unit need unbound (service<T>()); the feature passes its own handle.',
            });
          }
          const why = unreachable(state.name, witness as Ownership);
          if (why !== undefined) {
            throw new FeatureError({
              code: FEATURE_ERROR_CODES.missingCapability,
              message: `[feature] "${state.name}": infra unit "${p.name}" needs "${alias}", ${why}.`,
              remediation: "An infra unit may need public handles and its own feature's scope only.",
            });
          }
        }
      }
      return stage({ ...state, infra: units, step: STEP.infra });
    },
    domainServices: factories => {
      if (state.step > STEP.domainServices || state.domainServices !== undefined) {
        throw new FeatureError({
          code: FEATURE_ERROR_CODES.stepOrder,
          message: `[feature] "${state.name}": .domainServices() runs once, after .needs()/.infra() and before .features(), .usecases() and .provides().`,
          remediation: 'Declare every domain service in one .domainServices({ … }) call, right after .infra().',
        });
      }
      const infraKeys = new Set(state.infra.flatMap(p => Object.keys(p.provides)));
      for (const key of Object.keys(factories)) {
        if (RESERVED.has(key) || key in state.needs || infraKeys.has(key)) {
          throw collision(
            state.name,
            `domain service "${key}" collides with a need alias, an infra service or a reserved name`,
            'Rename the domain service; usecases see needs, infra and domain services by one key each.',
          );
        }
      }
      return stage({ ...state, domainServices: factories, step: STEP.domainServices });
    },
    usecases: factories => stage({ ...state, usecases: factories, step: STEP.usecases }),
    provides: factories => {
      const infraKeys = new Set(state.infra.flatMap(p => Object.keys(p.provides)));
      for (const key of Object.keys(factories)) {
        if (
          RESERVED.has(key) ||
          key === `${state.name}.usecases` ||
          key === `${state.name}.services` ||
          key === `feature.${state.name}`
        ) {
          throw collision(
            state.name,
            `provided service "${key}" is generated by the feature itself`,
            'Rename the provided service.',
          );
        }
        if (parentOf(state.name) !== undefined && infraKeys.has(key)) {
          throw collision(
            state.name,
            `provided service "${key}" collides with an infra service`,
            "Rename one of the two; both publish under this feature's name.",
          );
        }
      }
      return stage({ ...state, provides: factories, step: STEP.provides });
    },
    entrypoints: (...entrypoints) => compile(state, infra, handles, entrypoints),
  };
}

/**
 * Declare a feature. Pure data capture — nothing runs until the app boots.
 * See the module comment for the chain; `.entrypoints(...)` finishes it.
 */
export function defineFeature<const TName extends string>(name: TName & FeatureNameGuard<TName>): NeedsStage<TName> {
  if (name.includes('#')) {
    throw new FeatureError({
      code: FEATURE_ERROR_CODES.keyCollision,
      message: `[feature] "${name}": "#" marks an instance.`,
      remediation: `Define the feature as "${name.split('#')[0]}" and call .instance("${name.split('#').slice(1).join('#')}").`,
    });
  }
  // Erasure seam: one runtime object serves every stage; the stage types
  // decide which step is callable and type each step's input and result.
  return stage({
    name,
    needs: {},
    infra: [],
    domainServices: undefined,
    step: STEP.needs,
    children: [],
    usecases: undefined,
    provides: {},
  }) as unknown as NeedsStage<TName>;
}

/* ------------------------------------------------------------------ */
/* routerFor                                                           */
/* ------------------------------------------------------------------ */

/** An app contract: mount key → feature contract. The only place mount keys are written. */
export type AppContract = Readonly<Record<string, object>>;

type Mounted = { readonly name: string; readonly contract: unknown; readonly router: unknown };

/** For each app-contract key, the router of the one feature whose contract is that contract. */
export type RouterFor<A extends AppContract, F extends readonly Mounted[]> = {
  readonly [K in keyof A]: Extract<F[number], { readonly contract: A[K] }>['router'];
};

/** Feature contracts the app contract does not mount (features without an `rpc` entrypoint have `never`). */
type Unmounted<A extends AppContract, F extends readonly Mounted[]> = Exclude<F[number]['contract'], A[keyof A]>;

/** App-contract keys no feature implements. */
type Unimplemented<A extends AppContract, F extends readonly Mounted[]> = {
  [K in keyof A]: [Extract<F[number], { readonly contract: A[K] }>] extends [never] ? K : never;
}[keyof A];

/**
 * Resolve the app router from the app contract. Mount keys are written once,
 * in the app contract; each feature is found by contract identity. Compile
 * errors at the call: an app-contract key no feature implements, a feature
 * whose contract the app contract does not mount. Features without an `rpc`
 * entrypoint are skipped, so the app's whole feature list can be passed.
 * A nested feature's contract is mounted by its parent, not here.
 *
 * @throws {FeatureError} `ARKI_DOT_E029` / `ARKI_DOT_E030` for callers that skip the types.
 */
export function routerFor<const A extends AppContract, const F extends readonly Mounted[]>(
  app: A &
    ([Unimplemented<A, F>] extends [never]
      ? unknown
      : { readonly 'ARKI_FEATURE: app contract key has no feature': Unimplemented<A, F> }),
  features: F &
    ([Unmounted<A, F>] extends [never]
      ? unknown
      : { readonly 'ARKI_FEATURE: feature contract not mounted in the app contract': Unmounted<A, F> }),
): RouterFor<A, F> {
  const out: Record<string, unknown> = {};
  for (const [key, contract] of Object.entries(app)) {
    const owners = features.filter(f => f.contract === contract);
    const owner = owners[0];
    if (owners.length !== 1 || owner === undefined) {
      throw new FeatureError({
        code: FEATURE_ERROR_CODES.contractOwner,
        message: `[feature] app contract key "${key}" is implemented by ${owners.length} features; expected exactly one.`,
        remediation: 'Pass the feature whose rpc entrypoint uses this contract, once.',
      });
    }
    out[key] = owner.router;
  }
  const mounted = new Set<unknown>(Object.values(app));
  for (const f of features) {
    if (f.contract !== undefined && !mounted.has(f.contract)) {
      throw new FeatureError({
        code: FEATURE_ERROR_CODES.contractNotMounted,
        message: `[feature] the contract of feature "${f.name}" is not mounted in the app contract.`,
        remediation: `Add the contract of "${f.name}" to the app contract under its mount key.`,
      });
    }
  }
  // Erasure seam: resolved by contract identity at runtime; typed by the same lookup over the tuple.
  return out as RouterFor<A, F>;
}
