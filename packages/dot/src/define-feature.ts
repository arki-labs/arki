/**
 * `defineFeature(name)` — the chain form of a Dot feature
 * (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`; nesting and infra
 * needs: `docs/rfcs/2026-10-15-dot-feature-builder-nesting.md`).
 *
 *   defineFeature('daily-digest')
 *     .needs({ db: entrypointOnly(database.provides.db), plans: billing.provides.entitlements })
 *     .infra(store, mailer)                              its own plugins, private to it
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
 * Handles enter a feature through one door, `.needs()`. An infra plugin
 * declares its needs unbound (`service<Db>()`); `.infra()` binds each alias to
 * a sibling's key first, then to the feature's need of the same alias.
 *
 * The feature compiles to plain kernel units (`plugins()`): every infra
 * plugin, its keys qualified as `<feature>.<key>` and its unit named
 * `<feature>/<plugin>`, then each child's units, then one feature plugin.
 * Nothing in the kernel changes: ordering, rings, the manifest and
 * `dot explain` see ordinary plugins with ordinary edges
 * (`digest → digest/store → database`, `digest.compile → digest/store`).
 */
import type { FeatureSlice } from './feature.js';
import type {
  ActionSource,
  AnyHandle,
  AnyPlugin,
  CtxOf,
  EmptyShape,
  Handle,
  KernelCtx,
  NeedsShape,
  NoReservedKeys,
  Plugin,
  PluginNeeds,
  PluginProvides,
  Provided,
  Service,
  ServiceRecord,
  Token,
  WireNeeds,
} from './plugin-contract.js';
import { FEATURE_ERROR_CODES, FeatureError } from './feature-error.js';
import { traceUsecase } from './kernel/otel.js';
import { handleOf, isLazyWitness, rename } from './plugin-contract.js';

type MaybePromise<T> = T | Promise<T>;

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

/** The services the infra plugins provide, merged, under their local keys. */
export type InfraProvides<I extends readonly AnyPlugin[]> = I extends readonly []
  ? EmptyShape
  : UnionToIntersection<PluginProvides<I[number]>>;

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

/** What `.usecases(create)` receives: the usecase-visible needs by alias, the infra services and the children's services by local key. */
export type CoreDeps<N extends NeedsShape, I extends readonly AnyPlugin[], C extends readonly AnyDefinedFeature[]> = CtxOf<
  UsecaseNeeds<N>
> &
  InfraProvides<I> &
  ChildProvides<C>;

/** What `.provides` factories and every entrypoint receive: every need (entrypoint-only included), infra, children and the usecases object. */
export type CoreServices<N extends NeedsShape, I extends readonly AnyPlugin[], C extends readonly AnyDefinedFeature[], U> = CtxOf<N> &
  InfraProvides<I> &
  ChildProvides<C> & { readonly usecases: U };

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

/** The wire key of a provided service: bare at the top level, `<name>.<key>` inside a parent. */
type PublishKey<TName extends string, K> = K extends string ? (Nested<TName> extends true ? `${TName}.${K}` : K) : never;

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
  readonly [K in keyof Pub & string]: ScopedHandle<Pub[K], K, TName, ScopeFor<TName>>;
} & { readonly [K in keyof Own & string]: ScopedHandle<Own[K], K, TName, TName, true> };

/** The handles a qualified infra unit publishes: scoped to the feature. */
type InfraUnitHandles<TName extends string, P extends ServiceRecord> = {
  readonly [K in keyof P & string]: ScopedHandle<P[K], K, `${TName}/${string}`, TName>;
};

/** One handle per provided key (local key → handle on the published wire key). */
export type ScopedHandles<P extends ServiceRecord, TName extends string> = {
  readonly [K in keyof P & string]: ScopedHandle<P[K], PublishKey<TName, K>, TName, ScopeFor<TName>>;
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

/**
 * A child unit with its needs on the parent's infra keys (`TLocal`) remapped
 * to the qualified keys. The unit's own typed `provides` record is kept, so
 * its handles stay scoped/internal after the remap (Astra round 3).
 * Known gap: this remap is by KEY; the runtime remaps by handle identity.
 */
type RemappedUnit<TName extends string, TLocal, P extends AnyPlugin> = Plugin<
  { [K in keyof PluginNeeds<P> as K extends TLocal ? Qualify<TName, K> : K]: PluginNeeds<P>[K] },
  PluginProvides<P>
> &
  Pick<P, 'provides'>;
type RemappedUnits<TName extends string, TLocal, U extends readonly AnyPlugin[]> = {
  readonly [K in keyof U]: U[K] extends AnyPlugin ? RemappedUnit<TName, TLocal, U[K]> : never;
};
/** Every child's units, in declaration order, each remapped onto the parent's scope. */
export type ChildUnits<
  TName extends string,
  TLocal,
  C extends readonly AnyDefinedFeature[],
  Acc extends readonly AnyPlugin[] = readonly [],
> = C extends readonly [infer H extends AnyDefinedFeature, ...infer T extends readonly AnyDefinedFeature[]]
  ? ChildUnits<TName, TLocal, T, readonly [...Acc, ...RemappedUnits<TName, TLocal, ReturnType<H['plugins']>>]>
  : Acc;
/** The whole unit list of a feature with children: infra, children, then the feature itself. */
export type UnitsOf<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyPlugin[],
  C extends readonly AnyDefinedFeature[],
  Unit extends AnyPlugin,
> = ChildUnits<TName, keyof InfraProvides<I>, C, QualifiedInfra<TName, N, I>> extends infer U extends readonly AnyPlugin[]
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
/** A need may name a public handle, its own scope's private infra, or a nested feature's provides from inside that feature's parent. */
export type NeedsGuard<TName extends string, N> = ([InternalNeeds<N>] extends [never]
  ? unknown
  : { readonly "DOT: a need names a feature's internal handle (usecases/services); need its provides instead": InternalNeeds<N> }) &
  ([OutOfScope<TName, N>] extends [never]
    ? unknown
    : {
        readonly "DOT: a need reaches a private service from outside its scope (a feature's infra, or a nested feature's provides)": OutOfScope<
          TName,
          N
        >;
      });

type ChildName<C> = C extends { readonly name: infer X extends string } ? X : never;
type NotChildName<TName extends string, C extends readonly AnyDefinedFeature[]> = {
  [K in keyof C]: ChildName<C[K]> extends `${TName}.${string}` ? never : ChildName<C[K]>;
}[number];
type ChildKeyCollision<N, I extends readonly AnyPlugin[], C extends readonly AnyDefinedFeature[]> = keyof ChildProvides<C> &
  (keyof N | keyof InfraProvides<I> | ReservedAlias);
type SiblingDup<C extends readonly AnyDefinedFeature[], Seen = never> = C extends readonly [
  infer H extends AnyDefinedFeature,
  ...infer T extends readonly AnyDefinedFeature[],
]
  ? (keyof H['provides'] & Seen) | SiblingDup<T, Seen | keyof H['provides']>
  : never;
export type ChildrenGuard<
  TName extends string,
  N,
  I extends readonly AnyPlugin[],
  C extends readonly AnyDefinedFeature[],
> = ([NotChildName<TName, C>] extends [never]
  ? unknown
  : { readonly 'DOT: a child feature must be named `<parent>.<child>`': NotChildName<TName, C> }) &
  ([ChildKeyCollision<N, I, C>] extends [never]
    ? unknown
    : {
        readonly 'DOT: a child provides a key that collides with a need alias, an infra service or a reserved name': ChildKeyCollision<
          N,
          I,
          C
        >;
      }) &
  ([SiblingDup<C>] extends [never] ? unknown : { readonly 'DOT: two children provide the same key': SiblingDup<C> });

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
  : { readonly "DOT: a child feature has an rpc contract this feature's contract does not mount": UnmountedChild<C, E> };

/** The keys the feature generates for itself: a provides factory may not take them. */
type GeneratedKeys<TName extends string> = `${TName}.services` | `${TName}.usecases` | `feature.${TName}`;
/** Inside a parent, a provided key must not also be an infra key: both publish under `<name>.<key>`. */
type ProvidesGuard<TName extends string, I extends readonly AnyPlugin[], P> = ([keyof P & GeneratedKeys<TName>] extends [never]
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
type WireKeyOfNeed<W, K> = W extends Token<unknown, infer WK extends string> ? WK : K;

/**
 * An infra plugin after qualification: it provides under `<feature>.<key>`;
 * a need that named a sibling infra key (`TLocal`) names the qualified key,
 * so the sibling — not an app plugin — satisfies it; any other need alias is
 * the feature's need of that alias, on that handle's wire key.
 */
export type QualifiedPlugin<TName extends string, N extends NeedsShape, P extends AnyPlugin, TLocal> = Plugin<
  {
    [K in keyof PluginNeeds<P> as K extends TLocal ? Qualify<TName, K> : K extends keyof N ? WireKeyOfNeed<N[K], K> : K]: PluginNeeds<P>[K];
  },
  { [K in keyof PluginProvides<P> as Qualify<TName, K>]: PluginProvides<P>[K] }
> & { readonly provides: InfraUnitHandles<TName, { [K in keyof PluginProvides<P> as Qualify<TName, K>]: PluginProvides<P>[K] }> };

/** Every infra plugin qualified, as a tuple in declaration order. */
export type QualifiedInfra<TName extends string, N extends NeedsShape, I extends readonly AnyPlugin[]> = {
  readonly [K in keyof I]: I[K] extends AnyPlugin ? QualifiedPlugin<TName, N, I[K], keyof InfraProvides<I>> : never;
};

/**
 * The feature plugin: needs = the feature's needs + its qualified infra + its
 * children's provides; provides = the public services, `<feature>.usecases`,
 * `<feature>.services` and the slice record `feature.<feature>`.
 */
export type FeatureUnit<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyPlugin[],
  C extends readonly AnyDefinedFeature[],
  U,
  P extends ServiceRecord,
  E extends readonly AnyEntrypoint[],
> = Plugin<
  WireNeeds<N> & { [K in keyof InfraProvides<I> as Qualify<TName, K>]: InfraProvides<I>[K] } & WireNeeds<ChildHandles<C>>,
  { readonly [K in keyof P as PublishKey<TName, K>]: P[K] } & Readonly<Record<`${TName}.usecases`, U>> &
    Readonly<Record<`${TName}.services`, CoreServices<N, I, C, U>>> &
    Readonly<Record<`feature.${TName}`, EntrypointPayloads<E>>>
> & {
  readonly provides: UnitHandles<
    TName,
    { readonly [K in keyof P as PublishKey<TName, K>]: P[K] },
    Readonly<Record<`${TName}.usecases`, U>> &
      Readonly<Record<`${TName}.services`, CoreServices<N, I, C, U>>> &
      Readonly<Record<`feature.${TName}`, EntrypointPayloads<E>>>
  >;
};

/**
 * Every handle a request resolves for this feature: its needs, its infra
 * services (local key → qualified handle), its children's provides and its
 * usecases. `bind(logic)` hands a request the feature's `<name>.services`
 * record, which holds exactly these, resolved — so the handler sees
 * `context.usecases`, `context.store`, `context.plans`.
 */
export type CoreHandles<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyPlugin[],
  C extends readonly AnyDefinedFeature[],
  U,
> = N & {
  // Infra handles are scoped to this feature; the usecases handle is internal: nothing may need it.
  readonly [K in keyof InfraProvides<I> & string]: ScopedHandle<InfraProvides<I>[K], `${TName}.${K}`, `${TName}/${string}`, TName>;
} & ChildHandles<C> & { readonly usecases: ScopedHandle<U, `${TName}.usecases`, TName, TName, true> };

declare const CoreServicesTag: unique symbol;

/**
 * The feature up to `.usecases()`: name, handles and (type only) the
 * services its entrypoints receive. Entrypoint files take it as a typed
 * parameter (`import type`), so they never import the feature at runtime.
 */
export type FeatureCore<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyPlugin[],
  C extends readonly AnyDefinedFeature[],
  U,
> = {
  readonly name: TName;
  readonly handles: CoreHandles<TName, N, I, C, U>;
  readonly [CoreServicesTag]?: CoreServices<N, I, C, U>;
};

/** Any feature logic stage — the constraint entrypoint factories take (`schedules(logic, defs)`). */
export type AnyFeatureCore = { readonly name: string; readonly handles: NeedsShape };

/**
 * The services a stage hands its next step — types code declared in another
 * file. Before `.usecases()` it is what a usecase may ask for (needs + infra
 * + children, minus entrypoint-only needs); after, it is what entrypoints get
 * (every need + infra + children + `usecases`).
 */
export type DepsOf<C> = C extends { readonly [CoreServicesTag]?: infer D } ? D : never;

/** A finished feature: what `.entrypoints(...)` returns and `defineApp().features([...])` mounts. */
export type DefinedFeature<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyPlugin[],
  C extends readonly AnyDefinedFeature[],
  U,
  P extends ServiceRecord,
  E extends readonly AnyEntrypoint[],
> = FeatureCore<TName, N, I, C, U> & {
  /** Public handles, one per provided key — what other features name in their `needs`. Inside a parent they are scoped (`<name>.<key>`). */
  readonly provides: ScopedHandles<P, TName>;
  /** The nested features, as declared. Drivers and `dot explain` walk them. */
  readonly features: C;
  /** Raw infra handles this feature (or a descendant) owns → the owning feature. Checked by `mountFeatures`. */
  readonly owned: ReadonlyMap<object, string>;
  readonly entrypoints: E;
  /** The contract of the `rpc` entrypoint (`never` without one) — `routerFor` matches on it. */
  readonly contract: ContractOf<E>;
  readonly router: RouterOf<E>;
  /** Kernel units in boot order: the qualified infra plugins, each child's units, then the feature plugin. A tuple, so the app builder's guard checks it. */
  plugins(): UnitsOf<TName, N, I, C, FeatureUnit<TName, N, I, C, U, P, E>>;
  /**
   * Replace infra services by local key before compilation (tests), this
   * feature's (`repos`) or a child's (`'compile.ranker'`). The plugin that
   * provides a key is rebuilt in place: same name and needs, the overridden
   * keys return the value, its other keys keep their factory. Its lifecycle
   * hooks are dropped — they were written for the real services.
   * Entrypoints and provides are kept.
   */
  override(values: Partial<InfraProvides<I>> & ChildOverrides<TName, C>): DefinedFeature<TName, N, I, C, U, P, E>;
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
  plugins(): readonly AnyPlugin[];
};

/* ---- guards: collisions are compile errors at the offending step ---- */

type InfraCollision<N, I extends readonly AnyPlugin[]> = keyof InfraProvides<I> & (keyof N | ReservedAlias);
/** What no need resolves to: a type no service satisfies, so the alias is reported. */
type Undeclared = { readonly 'DOT: undeclared need': never };
/** What an infra plugin's need alias resolves to inside the feature: a sibling's service, else the feature's need, else nothing. */
type ResolvedInfraNeed<N extends NeedsShape, I extends readonly AnyPlugin[], K> = K extends keyof InfraProvides<I>
  ? InfraProvides<I>[K]
  : K extends keyof N
    ? CtxOf<N>[K]
    : Undeclared;
/** The need aliases of the infra plugins that no sibling and no declared need satisfies (missing, or of another type). */
type UnsatisfiedInfraNeeds<N extends NeedsShape, I extends readonly AnyPlugin[]> = {
  [J in keyof I]: I[J] extends AnyPlugin
    ? { [K in keyof PluginNeeds<I[J]>]: ResolvedInfraNeed<N, I, K> extends PluginNeeds<I[J]>[K] ? never : K }[keyof PluginNeeds<I[J]>]
    : never;
}[number];
type InfraGuard<N extends NeedsShape, I extends readonly AnyPlugin[]> = ([InfraCollision<N, I>] extends [never]
  ? unknown
  : { readonly 'DOT: an infra service key collides with a need alias or a reserved name': InfraCollision<N, I> }) &
  ([UnsatisfiedInfraNeeds<N, I>] extends [never]
    ? unknown
    : {
        readonly 'DOT: an infra plugin needs a service the feature does not declare in .needs() (or declares with another type)': UnsatisfiedInfraNeeds<
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

/** The usecases object: each factory's return under its key. */
export type Usecases<F extends UsecaseFactories> = { readonly [K in keyof F]: ReturnType<F[K]> };

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

/* ---- stages: each offers only the later steps ---- */

export type EntrypointsStage<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyPlugin[],
  C extends readonly AnyDefinedFeature[],
  U,
  P extends ServiceRecord,
> = FeatureCore<TName, N, I, C, U> & {
  /** Finish the feature. Call it with no argument for a feature nothing reaches directly. */
  entrypoints<const E extends readonly Entrypoint<CoreServices<N, I, C, U> & KernelCtx>[]>(
    ...entrypoints: E & EntrypointGuard<P, E> & ChildContractGuard<C, E>
  ): DefinedFeature<TName, N, I, C, U, P, E>;
};

export type ProvidesStage<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyPlugin[],
  C extends readonly AnyDefinedFeature[],
  U,
> = EntrypointsStage<TName, N, I, C, U, EmptyShape> & {
  /** Public services, one factory per key; each gets needs, infra, the children's services and usecases. */
  provides<P extends ServiceRecord & NoReservedKeys & NoKeys<ReservedAlias> = EmptyShape>(
    factories: {
      readonly [K in keyof P]: (services: CoreServices<N, I, C, U> & KernelCtx) => MaybePromise<P[K]>;
    } & ProvidesGuard<TName, I, P>,
  ): EntrypointsStage<TName, N, I, C, U, P>;
};

export type UsecasesStage<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyPlugin[],
  C extends readonly AnyDefinedFeature[],
> = Omit<ProvidesStage<TName, N, I, C, EmptyShape>, typeof CoreServicesTag> & {
  /**
   * Before `.usecases()` there are no usecases, so `DepsOf<typeof <feature>Deps>` is
   * exactly what a usecase may ask for — needs + infra + children, no `usecases` key.
   */
  readonly [CoreServicesTag]?: CoreDeps<N, I, C>;
  /**
   * One factory per usecase, built once per boot: `{ signup, markInvited }`,
   * each `(deps) => usecase`. A factory may ask for any subset of the deps
   * (`Pick<Deps, 'repos'>`); asking for one the feature lacks is a compile
   * error naming the usecase.
   */
  usecases<const F extends UsecaseFactories>(
    factories: F & UsecaseGuard<CoreDeps<N, I, C>, F>,
  ): ProvidesStage<TName, N, I, C, Usecases<F>>;
};

export type FeaturesStage<TName extends string, N extends NeedsShape, I extends readonly AnyPlugin[]> = UsecasesStage<
  TName,
  N,
  I,
  readonly []
> & {
  /**
   * The feature's own features, in boot order — each a finished feature
   * named `<this>.<child>`. A child sees this feature's infra (by handle)
   * and its earlier siblings' provides; its provides are seen here and by
   * its siblings, nowhere else.
   */
  features<const C extends readonly AnyDefinedFeature[]>(
    ...children: C & ChildrenGuard<TName, N, I, C>
  ): UsecasesStage<TName, N, I, C>;
};

export type InfraStage<TName extends string, N extends NeedsShape> = FeaturesStage<TName, N, readonly []> & {
  /**
   * The feature's own plugins, in boot order. Their keys are private to this
   * feature and its children. A plugin's need alias is bound to a sibling's
   * key first, then to the feature's need of the same alias; anything else
   * is a compile error naming the alias.
   */
  infra<const I extends readonly AnyPlugin[]>(...plugins: I & InfraGuard<N, I>): FeaturesStage<TName, N, I>;
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

type FeatureState = {
  readonly name: string;
  readonly needs: NeedsShape;
  readonly infra: readonly AnyPlugin[];
  readonly children: readonly RuntimeFeature[];
  readonly usecases: Factory | undefined;
  readonly provides: Readonly<Record<string, Factory>>;
};

type RuntimeFeature = {
  readonly name: string;
  readonly handles: NeedsShape;
  readonly provides: Readonly<Record<string, AnyHandle>>;
  readonly features: readonly RuntimeFeature[];
  readonly owned: ReadonlyMap<object, string>;
  readonly entrypoints: readonly AnyEntrypoint[];
  readonly contract: unknown;
  readonly router: unknown;
  plugins(): readonly AnyPlugin[];
  override(values: Readonly<Record<string, unknown>>): RuntimeFeature;
};

type RuntimeStage = {
  readonly name: string;
  readonly handles: NeedsShape;
  needs(needs: NeedsShape): RuntimeStage;
  infra(...plugins: readonly AnyPlugin[]): RuntimeStage;
  features(...children: readonly RuntimeFeature[]): RuntimeStage;
  usecases(factories: Readonly<Record<string, Factory>>): RuntimeStage;
  provides(factories: Readonly<Record<string, Factory>>): RuntimeStage;
  entrypoints(...entrypoints: readonly AnyEntrypoint[]): RuntimeFeature;
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

/** A feature and every descendant, depth-first in declaration order — what drivers and `dot explain` walk. Each node once. */
export function allFeatures<F extends { readonly name: string }>(features: readonly F[]): readonly F[] {
  // An object-form feature has no `features`; a chain feature lists its children there.
  const childrenOf = (f: F): readonly F[] => ('features' in f && Array.isArray(f.features) ? (f.features as readonly F[]) : []);
  return features.flatMap(f => [f, ...allFeatures(childrenOf(f))]);
}

/** A node's OWN kernel units — its qualified infra and its feature unit — never a descendant's. Adapters read declarations from these. */
export function ownUnits(feature: AnyDefinedFeature): readonly AnyPlugin[] {
  return feature.plugins().filter(u => u.name === feature.name || u.name.startsWith(`${feature.name}/`));
}

/** `H` with its ownership stripped: the same handle, public. */
type PublicHandle<H> = H extends Handle<infer T, infer K extends string, infer O extends string> ? Handle<T, K, O> : never;
/** The `<name>.services` handles among a unit list's provides, public. */
type ServicesHandlesIn<Units> = Units extends readonly (infer U)[]
  ? U extends { readonly provides: infer P }
    ? { readonly [K in keyof P & `${string}.services`]: PublicHandle<P[K]> }
    : never
  : never;
/** What a gateway needs to serve these features' requests: their public handles, and every node's `<name>.services`. */
export type RequestHandles<T extends readonly AnyDefinedFeature[]> = UnionToIntersection<T[number]['provides']> &
  UnionToIntersection<ServicesHandlesIn<ReturnType<T[number]['plugins']>>>;

/**
 * The handles a gateway needs to serve requests for these features, as one
 * `provides` record: the top-level features' public handles, and the
 * `<name>.services` bag of every node (nested children included), which
 * `bind(core)` reads per request. The bags are published public here on
 * purpose — serving requests is the assembly's job, not a feature's — so a
 * gateway may spread them into `.needs()`:
 *
 * ```ts
 * const units = [...legacy, requestServices(converted)];
 * defineFeature('gateway').needs({ db, ...providesOf(units) }).provides({ rpc: ctx => servicesOf(ctx, units) … })
 * ```
 */
export function requestServices<const T extends readonly AnyDefinedFeature[]>(
  features: T,
): { readonly provides: RequestHandles<T> } {
  const provides: Record<string, AnyHandle> = {};
  for (const f of features) Object.assign(provides, f.provides);
  for (const node of allFeatures(features)) provides[`${node.name}.services`] = handleOf(`${node.name}.services`, node.name);
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
 * @throws {FeatureError} `FEATURE_E005` naming the unit, the alias and the owning feature.
 */
export function mountFeatures(features: readonly AnyDefinedFeature[]): {
  readonly features: readonly AnyDefinedFeature[];
  readonly units: readonly AnyPlugin[];
} {
  const nodes = allFeatures(features);
  const owned = new Map<object, string>();
  for (const f of nodes) for (const [handle, scope] of f.owned) owned.set(handle, scope);
  const units = features.flatMap(f => f.plugins());
  for (const unit of units) {
    const feature = unit.name.split('/')[0] ?? unit.name;
    for (const [alias, witness] of Object.entries(unit.needs)) {
      // A remapped need (or an entrypointOnly clone) keeps the handle it was written with under `origin`.
      const scope = owned.get(canonical(witness));
      if (scope !== undefined && !within(feature, scope)) {
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
function remapNeeds(unit: AnyPlugin, ownedInfra: ReadonlyMap<object, Remap>): AnyPlugin {
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
 * Qualify every infra plugin: keys → `<feature>.<key>`, names → `<feature>/<plugin>`,
 * sibling needs → the qualified key, every other need alias → the feature's own handle.
 */
function qualifyInfra(
  feature: string,
  declared: NeedsShape,
  infra: readonly AnyPlugin[],
): { readonly units: readonly AnyPlugin[]; readonly handles: Readonly<Record<string, AnyHandle>> } {
  const unitByKey = new Map<string, string>();
  for (const p of infra) for (const key of Object.keys(p.provides)) unitByKey.set(key, `${feature}/${p.name}`);

  const handles: Record<string, AnyHandle> = {};
  const units = infra.map((p): AnyPlugin => {
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
        needs[alias] = isLazyWitness(witness) && !isLazyWitness(own) ? ((own as Provenance).lazy as Service<unknown> | undefined) ?? own : own;
        continue;
      }
      // The sibling's key is qualified now; the need follows it (a lazy witness stays lazy).
      const handle = handleOf(`${feature}.${key}`, sibling);
      needs[alias] = isLazyWitness(witness) ? handle.lazy : handle;
    }
    const renamed = rename(p, qualified, unitName);
    // The unit's own handles carry ownership too, so `plugins()[i].provides[k]` is refused outside the feature.
    const provides = Object.fromEntries(Object.keys(renamed.provides).map(key => [key, scopedHandleOf(key, unitName, feature)]));
    return { ...renamed, needs, provides };
  });
  return { units, handles };
}

/** Rebuild one infra plugin with some services replaced; untouched plugins are returned as they are. */
function replaceServices(p: AnyPlugin, values: Readonly<Record<string, unknown>>, used: Set<string>): AnyPlugin {
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
  return touched ? { ...p, factories, hooks: {} } : p;
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
  // By router identity: `rpc(contract, implementer, { compile: () => compile.router })` keeps the child's router object as it is.
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

function compile(
  state: FeatureState,
  infra: ReturnType<typeof qualifyInfra>,
  handles: NeedsShape,
  entrypoints: readonly AnyEntrypoint[],
): RuntimeFeature {
  checkEntrypoints(state, entrypoints);
  checkChildContracts(state, entrypoints);
  const usecasesKey = `${state.name}.usecases`;
  const servicesKey = `${state.name}.services`;
  const sliceKey = `feature.${state.name}`;
  const nested = parentOf(state.name) !== undefined;
  // Inside a parent a provided key is scoped: `digest.compile.compiler`. At the top level it is public and bare.
  const publishKey = (key: string): string => (nested ? `${state.name}.${key}` : key);
  // This feature's raw infra handles (and their lazy forms) → where they live now (`digest.repos`, unit `digest/store`).
  const ownedInfra = new Map<object, Remap>();
  for (const p of state.infra) {
    for (const [key, h] of Object.entries(p.provides)) {
      const target: Remap = { key: `${state.name}.${key}`, unit: `${state.name}/${p.name}`, scope: state.name };
      ownedInfra.set(h, target);
      ownedInfra.set(h.lazy, target);
    }
  }
  // Entrypoint-only needs: in the unit's needs (boot order, explain), out of the usecases' deps.
  const doorKeys = new Set(
    Object.entries(state.needs)
      .filter(([, w]) => (w as Provenance).entrypointOnly === true)
      .map(([k]) => k),
  );

  // A kernel factory sees the unit's needs, never its sibling provides, so the
  // usecases object is built once per boot (the kernel hands every factory of
  // one unit the same ctx object) and shared by every factory and entrypoint.
  const built = new WeakMap<object, unknown>();
  const usecasesOf = (ctx: object): unknown => {
    if (!built.has(ctx)) {
      // Erasure seam: each factory was typed against these deps by `.usecases()`.
      const usecaseDeps = Object.fromEntries(Object.entries(ctx).filter(([k]) => !doorKeys.has(k)));
      built.set(ctx, state.usecases === undefined ? {} : state.usecases(usecaseDeps as never));
    }
    return built.get(ctx);
  };
  const servicesOf = (ctx: object): object => ({ ...ctx, usecases: usecasesOf(ctx) });

  const factories: Record<string, (ctx: object) => unknown> = {
    [usecasesKey]: usecasesOf,
    // The resolved services (needs + infra + children + usecases, by local key) — what `bind(logic)` hands a request.
    // One key per feature, read by the feature's own name: no per-handle resolution, so a remapped need just works.
    // The kernel's `$` keys stay out: a handler context carries the feature's services, not the kernel's.
    [servicesKey]: ctx => Object.fromEntries(Object.entries(servicesOf(ctx)).filter(([k]) => !k.startsWith('$'))),
    // One record under `feature.<name>`, keyed by entrypoint key — what `sliceOf` reads.
    [sliceKey]: ctx => {
      const services = servicesOf(ctx);
      // Erasure seam: each entrypoint was typed against these services by `.entrypoints()`.
      return Object.fromEntries(entrypoints.map(e => [e.key, e.resolve(services as never)]));
    },
  };
  for (const [key, factory] of Object.entries(state.provides)) {
    // Erasure seam: each factory was typed against these services by `.provides()`.
    factories[publishKey(key)] = ctx => factory(servicesOf(ctx) as never);
  }

  // The unit's published handles keep ownership too: provides scoped to the parent, generated keys internal.
  const unitHandles: Record<string, Handle<unknown, string>> = {};
  for (const key of Object.keys(factories)) {
    const generated = key === usecasesKey || key === servicesKey || key === sliceKey;
    unitHandles[key] = scopedHandleOf(key, state.name, generated ? state.name : parentOf(state.name), generated);
  }
  // The record plugin() builds, written out: the needs here are already handles, and the keys already wire keys.
  const unit: AnyPlugin = {
    name: state.name,
    needs: { ...state.needs, ...infra.handles, ...childHandles(state.children) },
    actions: entrypoints.flatMap(e => [...e.actions, ...(e.actionsOf?.(state.name, state.children) ?? [])]),
    renames: {},
    role: 'feature',
    provides: unitHandles,
    factories,
    hooks: {},
  };
  // Boot order: this feature's infra, then each child (its own units, any depth), then this feature.
  const units: readonly AnyPlugin[] = [
    ...infra.units,
    ...state.children.flatMap(c => c.plugins().map(u => remapNeeds(u, ownedInfra))),
    unit,
  ];

  const provides: Record<string, AnyHandle> = {};
  for (const key of Object.keys(state.provides)) provides[key] = scopedHandleOf(publishKey(key), state.name, parentOf(state.name));
  // Raw infra handles this feature owns (and its descendants'): what `mountFeatures` refuses to outsiders.
  const owned = new Map<object, string>(state.children.flatMap(c => [...c.owned]));
  for (const p of state.infra) {
    for (const h of Object.values(p.provides)) {
      owned.set(h, state.name);
      owned.set(h.lazy, state.name);
    }
  }
  const rpc = entrypoints.find(e => e.kind === 'rpc');

  return {
    name: state.name,
    handles,
    provides,
    features: state.children,
    owned,
    entrypoints,
    contract: rpc !== undefined && 'contract' in rpc ? rpc.contract : undefined,
    router: rpc !== undefined && 'router' in rpc ? rpc.router : undefined,
    plugins: () => units,
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
            message: `[feature] "${state.name}": override("${key}") names no service of its infra plugins.`,
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
  };
}

function stage(state: FeatureState): RuntimeStage {
  const infra = qualifyInfra(state.name, state.needs, state.infra);
  const handles: NeedsShape = {
    ...state.needs,
    ...infra.handles,
    ...childHandles(state.children),
    usecases: scopedHandleOf(`${state.name}.usecases`, state.name, state.name, true),
  };
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
      }
      return stage({ ...state, needs });
    },
    features: (...children) => {
      const seen = new Map<string, string>(
        [...Object.keys(state.needs), ...state.infra.flatMap(p => Object.keys(p.provides))].map(k => [k, state.name]),
      );
      for (const child of children) {
        if (parentOf(child.name) !== state.name) {
          throw new FeatureError({
            code: FEATURE_ERROR_CODES.keyCollision,
            message: `[feature] "${state.name}": child "${child.name}" is not named "${state.name}.<child>".`,
            remediation: `Name the child "${state.name}.${child.name.split('.').at(-1)}" (its folder sits under this feature's).`,
          });
        }
        for (const key of Object.keys(child.provides)) {
          const owner = seen.get(key);
          if (RESERVED.has(key) || owner !== undefined) {
            throw collision(
              state.name,
              `child "${child.name}" provides "${key}", which collides with ${owner === state.name ? 'a need alias or an infra service' : `a service of "${owner}"`}`,
              'Rename one of the two; inside a feature one key means one thing.',
            );
          }
          seen.set(key, child.name);
        }
      }
      return stage({ ...state, children });
    },
    infra: (...plugins) => {
      const seen = new Set<string>();
      for (const key of plugins.flatMap(p => Object.keys(p.provides))) {
        if (RESERVED.has(key) || key in state.needs || seen.has(key)) {
          throw collision(
            state.name,
            `infra service "${key}" collides with a need alias, another infra service or a reserved name`,
            'Give one of them another key with rename(), or another need alias.',
          );
        }
        seen.add(key);
      }
      const siblingKeys = new Set(plugins.flatMap(p => Object.keys(p.provides)));
      for (const p of plugins) {
        for (const [alias, witness] of Object.entries(p.needs)) {
          if (siblingKeys.has(wireKeyOf(witness, alias))) continue;
          const own = state.needs[alias];
          if (own === undefined) {
            throw new FeatureError({
              code: FEATURE_ERROR_CODES.missingCapability,
              message: `[feature] "${state.name}": infra plugin "${p.name}" needs "${alias}", which the feature does not declare.`,
              remediation: `Add it to .needs({ ${alias}: … }); the feature's handle is what the plugin gets.`,
            });
          }
          if ('key' in witness && !sameHandle(witness, own)) {
            throw new FeatureError({
              code: FEATURE_ERROR_CODES.missingCapability,
              message: `[feature] "${state.name}": infra plugin "${p.name}" binds "${alias}" to a handle other than the feature's.`,
              remediation: 'Declare the plugin need unbound (service<T>()); the feature passes its own handle.',
            });
          }
          const why = unreachable(state.name, witness as Ownership);
          if (why !== undefined) {
            throw new FeatureError({
              code: FEATURE_ERROR_CODES.missingCapability,
              message: `[feature] "${state.name}": infra plugin "${p.name}" needs "${alias}", ${why}.`,
              remediation: "An infra plugin may need public handles and its own feature's scope only.",
            });
          }
        }
      }
      return stage({ ...state, infra: plugins });
    },
    usecases: factories =>
      stage({
        ...state,
        // One object, one key per factory, each built from the same deps; each
        // usecase runs in its own `feature.<name>.<usecase>` span.
        usecases: deps =>
          Object.fromEntries(
            Object.entries(factories).map(([key, create]) => [key, traceUsecase(state.name, key, create(deps))]),
          ),
      }),
    provides: factories => {
      const infraKeys = new Set(state.infra.flatMap(p => Object.keys(p.provides)));
      for (const key of Object.keys(factories)) {
        if (RESERVED.has(key) || key === `${state.name}.usecases` || key === `${state.name}.services` || key === `feature.${state.name}`) {
          throw collision(state.name, `provided service "${key}" is generated by the feature itself`, 'Rename the provided service.');
        }
        if (parentOf(state.name) !== undefined && infraKeys.has(key)) {
          throw collision(
            state.name,
            `provided service "${key}" collides with an infra service`,
            "Rename one of the two; both publish under this feature's name.",
          );
        }
      }
      return stage({ ...state, provides: factories });
    },
    entrypoints: (...entrypoints) => compile(state, infra, handles, entrypoints),
  };
}

/**
 * Declare a feature. Pure data capture — nothing runs until the app boots.
 * See the module comment for the chain; `.entrypoints(...)` finishes it.
 */
export function defineFeature<const TName extends string>(name: TName): NeedsStage<TName> {
  // Erasure seam: one runtime object serves every stage; the stage types
  // decide which step is callable and type each step's input and result.
  return stage({ name, needs: {}, infra: [], children: [], usecases: undefined, provides: {} }) as unknown as NeedsStage<TName>;
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
 * @throws {FeatureError} `FEATURE_E008` / `FEATURE_E009` for callers that skip the types.
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
