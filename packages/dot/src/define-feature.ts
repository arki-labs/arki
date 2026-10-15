/**
 * `defineFeature(name)` — the chain form of a Dot feature
 * (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`).
 *
 *   defineFeature('daily-digest')
 *     .needs({ plans: billing.provides.entitlements })   what it takes from other units, by handle
 *     .infra(store, mailer)                              its own plugins, private to it
 *     .usecases({ preview, send })                       what it does: one factory per usecase
 *     .provides({ digests: ({ usecases }) => … })        what it offers other features
 *     .entrypoints(rpc(…), schedules(…), …)              how it is reached
 *
 * Each step's type offers only the later steps, so a step out of order does
 * not compile. Each step's input is typed from the earlier ones: usecases get
 * `{ ...needs, ...infra }`; `provides` factories and entrypoints get the same
 * plus `usecases`.
 *
 * The feature compiles to plain kernel units (`plugins()`): every infra
 * plugin, its keys qualified as `<feature>.<key>` and its unit named
 * `<feature>/<plugin>`, then one feature plugin. Nothing in the kernel
 * changes: ordering, rings, the manifest and `dot explain` see ordinary
 * plugins with ordinary edges (`digest → digest/store → database`).
 */
import type { FeatureSlice } from './feature.js';
import type {
  ActionSource,
  AnyHandle,
  AnyPlugin,
  CtxOf,
  EmptyShape,
  Handle,
  Handles,
  KernelCtx,
  NeedsShape,
  NoReservedKeys,
  Plugin,
  PluginNeeds,
  PluginProvides,
  Service,
  ServiceRecord,
  WireNeeds,
} from './plugin-contract.js';
import { FEATURE_ERROR_CODES, FeatureError } from './feature-error.js';
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

/** What `.usecases(create)` receives: the needs by alias and the infra services by local key. */
export type CoreDeps<N extends NeedsShape, I extends readonly AnyPlugin[]> = CtxOf<N> & InfraProvides<I>;

/** What `.provides` factories and every entrypoint receive: the deps plus the usecases object. */
export type CoreServices<N extends NeedsShape, I extends readonly AnyPlugin[], U> = CoreDeps<N, I> & {
  readonly usecases: U;
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
   * Called when the feature compiles.
   */
  readonly actionsOf?: (feature: string) => readonly ActionSource[];
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

/**
 * An infra plugin after qualification: it provides under `<feature>.<key>`,
 * and a need that named a sibling infra key (`TLocal`) names the qualified
 * key, so the sibling — not an app plugin — satisfies it.
 */
export type QualifiedPlugin<TName extends string, P extends AnyPlugin, TLocal> = Plugin<
  { [K in keyof PluginNeeds<P> as K extends TLocal ? Qualify<TName, K> : K]: PluginNeeds<P>[K] },
  { [K in keyof PluginProvides<P> as Qualify<TName, K>]: PluginProvides<P>[K] }
>;

/** Every infra plugin qualified, as a tuple in declaration order. */
export type QualifiedInfra<TName extends string, I extends readonly AnyPlugin[]> = {
  readonly [K in keyof I]: I[K] extends AnyPlugin ? QualifiedPlugin<TName, I[K], keyof InfraProvides<I>> : never;
};

/**
 * The feature plugin: needs = the feature's needs + its qualified infra;
 * provides = the public services, `<feature>.usecases` and the slice record
 * `feature.<feature>`.
 */
export type FeatureUnit<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyPlugin[],
  U,
  P extends ServiceRecord,
  E extends readonly AnyEntrypoint[],
> = Plugin<
  WireNeeds<N> & { [K in keyof InfraProvides<I> as Qualify<TName, K>]: InfraProvides<I>[K] },
  P & Readonly<Record<`${TName}.usecases`, U>> & Readonly<Record<`feature.${TName}`, EntrypointPayloads<E>>>
>;

/**
 * Every handle a request resolves for this feature: its needs, its infra
 * services (local key → qualified handle) and its usecases. A middleware
 * resolves them from the request's services bag (`resolveNeeds`), so the
 * handler sees `context.usecases`, `context.store`, `context.plans` — and not
 * `context.db`, which is the store's need, not the feature's.
 */
export type CoreHandles<TName extends string, N extends NeedsShape, I extends readonly AnyPlugin[], U> = N & {
  readonly [K in keyof InfraProvides<I> & string]: Handle<InfraProvides<I>[K], `${TName}.${K}`>;
} & { readonly usecases: Handle<U, `${TName}.usecases`, TName> };

declare const CoreServicesTag: unique symbol;

/**
 * The feature up to `.usecases()`: name, handles and (type only) the
 * services its entrypoints receive. Entrypoint files take it as a typed
 * parameter (`import type`), so they never import the feature at runtime.
 */
export type FeatureCore<TName extends string, N extends NeedsShape, I extends readonly AnyPlugin[], U> = {
  readonly name: TName;
  readonly handles: CoreHandles<TName, N, I, U>;
  readonly [CoreServicesTag]?: CoreServices<N, I, U>;
};

/** Any feature logic stage — the constraint entrypoint factories take (`schedules(logic, defs)`). */
export type AnyFeatureCore = { readonly name: string; readonly handles: NeedsShape };

/**
 * The services a stage hands its next step — types code declared in another
 * file. Before `.usecases()` it is what a usecase may ask for (needs + infra);
 * after, it is what entrypoints get (the same plus `usecases`).
 */
export type DepsOf<C> = C extends { readonly [CoreServicesTag]?: infer D } ? D : never;

/** A finished feature: what `.entrypoints(...)` returns and `defineApp().features([...])` mounts. */
export type DefinedFeature<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyPlugin[],
  U,
  P extends ServiceRecord,
  E extends readonly AnyEntrypoint[],
> = FeatureCore<TName, N, I, U> & {
  /** Public handles, one per provided key — what other features name in their `needs`. */
  readonly provides: Handles<P, TName>;
  readonly entrypoints: E;
  /** The contract of the `rpc` entrypoint (`never` without one) — `routerFor` matches on it. */
  readonly contract: ContractOf<E>;
  readonly router: RouterOf<E>;
  /** Kernel units in boot order: the qualified infra plugins, then the feature plugin. A tuple, so the app builder's guard checks it. */
  plugins(): readonly [...QualifiedInfra<TName, I>, FeatureUnit<TName, N, I, U, P, E>];
  /**
   * Replace infra services by local key before compilation (tests). The
   * plugin that provides a key is rebuilt in place: same name and needs, the
   * overridden keys return the value, its other keys keep their factory.
   * Its lifecycle hooks are dropped — they were written for the real
   * services. Entrypoints and provides are kept.
   */
  override(values: Partial<InfraProvides<I>>): DefinedFeature<TName, N, I, U, P, E>;
};

/** The erased finished feature — what the app builder accepts. */
export type AnyDefinedFeature = {
  readonly name: string;
  readonly provides: Readonly<Record<string, AnyHandle>>;
  readonly entrypoints: readonly AnyEntrypoint[];
  plugins(): readonly AnyPlugin[];
};

/* ---- guards: collisions are compile errors at the offending step ---- */

type InfraCollision<N, I extends readonly AnyPlugin[]> = keyof InfraProvides<I> & (keyof N | ReservedAlias);
type InfraGuard<N, I extends readonly AnyPlugin[]> = [InfraCollision<N, I>] extends [never]
  ? unknown
  : { readonly 'DOT: an infra service key collides with a need alias or a reserved name': InfraCollision<N, I> };

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
type BadUsecases<D, F extends UsecaseFactories> = {
  [K in keyof F]: [D] extends [DepsAskedBy<F[K]>] ? never : K;
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
  U,
  P extends ServiceRecord,
> = FeatureCore<TName, N, I, U> & {
  /** Finish the feature. Call it with no argument for a feature nothing reaches directly. */
  entrypoints<const E extends readonly Entrypoint<CoreServices<N, I, U> & KernelCtx>[]>(
    ...entrypoints: E & EntrypointGuard<P, E>
  ): DefinedFeature<TName, N, I, U, P, E>;
};

export type ProvidesStage<
  TName extends string,
  N extends NeedsShape,
  I extends readonly AnyPlugin[],
  U,
> = EntrypointsStage<TName, N, I, U, EmptyShape> & {
  /** Public services, one factory per key; each gets needs, infra and usecases. */
  provides<P extends ServiceRecord & NoReservedKeys & NoKeys<ReservedAlias> = EmptyShape>(factories: {
    readonly [K in keyof P]: (services: CoreServices<N, I, U> & KernelCtx) => MaybePromise<P[K]>;
  }): EntrypointsStage<TName, N, I, U, P>;
};

export type UsecasesStage<TName extends string, N extends NeedsShape, I extends readonly AnyPlugin[]> = Omit<
  ProvidesStage<TName, N, I, EmptyShape>,
  typeof CoreServicesTag
> & {
  /**
   * Before `.usecases()` there are no usecases, so `DepsOf<typeof <feature>Deps>` is
   * exactly what a usecase may ask for — needs + infra, no `usecases` key.
   */
  readonly [CoreServicesTag]?: CoreDeps<N, I>;
  /**
   * One factory per usecase, built once per boot: `{ signup, markInvited }`,
   * each `(deps) => usecase`. A factory may ask for any subset of the deps
   * (`Pick<Deps, 'repos'>`); asking for one the feature lacks is a compile
   * error naming the usecase.
   */
  usecases<const F extends UsecaseFactories>(
    factories: F & UsecaseGuard<CoreDeps<N, I>, F>,
  ): ProvidesStage<TName, N, I, Usecases<F>>;
};

export type InfraStage<TName extends string, N extends NeedsShape> = UsecasesStage<TName, N, readonly []> & {
  /** The feature's own plugins, in boot order. Their keys are private to this feature. */
  infra<const I extends readonly AnyPlugin[]>(...plugins: I & InfraGuard<N, I>): UsecasesStage<TName, N, I>;
};

export type NeedsStage<TName extends string> = InfraStage<TName, EmptyShape> & {
  /** What the feature takes from other units, by handle, under local aliases. */
  needs<N extends NeedsShape & NoReservedKeys & NoKeys<ReservedAlias> = EmptyShape>(needs: N): InfraStage<TName, N>;
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
  readonly usecases: Factory | undefined;
  readonly provides: Readonly<Record<string, Factory>>;
};

type RuntimeFeature = {
  readonly name: string;
  readonly handles: NeedsShape;
  readonly provides: Readonly<Record<string, AnyHandle>>;
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

/** The wire key a witness names: a token's own key, else the alias (anonymous `service<T>()`). */
function wireKeyOf(witness: Service<unknown>, alias: string): string {
  return 'key' in witness && typeof witness.key === 'string' ? witness.key : alias;
}

/** Qualify every infra plugin: keys → `<feature>.<key>`, names → `<feature>/<plugin>`, sibling needs → the qualified key. */
function qualifyInfra(
  feature: string,
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
      handles[key] = handleOf(`${feature}.${key}`, unitName);
    }
    const needs: Record<string, Service<unknown>> = {};
    for (const [alias, witness] of Object.entries(p.needs)) {
      const key = wireKeyOf(witness, alias);
      const sibling = unitByKey.get(key);
      if (sibling === undefined) {
        needs[alias] = witness;
        continue;
      }
      // The sibling's key is qualified now; the need follows it (a lazy witness stays lazy).
      const handle = handleOf(`${feature}.${key}`, sibling);
      needs[alias] = isLazyWitness(witness) ? handle.lazy : handle;
    }
    return { ...rename(p, qualified, unitName), needs };
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

function compile(
  state: FeatureState,
  infra: ReturnType<typeof qualifyInfra>,
  handles: NeedsShape,
  entrypoints: readonly AnyEntrypoint[],
): RuntimeFeature {
  checkEntrypoints(state, entrypoints);
  const usecasesKey = `${state.name}.usecases`;
  const sliceKey = `feature.${state.name}`;

  // A kernel factory sees the unit's needs, never its sibling provides, so the
  // usecases object is built once per boot (the kernel hands every factory of
  // one unit the same ctx object) and shared by every factory and entrypoint.
  const built = new WeakMap<object, unknown>();
  const usecasesOf = (ctx: object): unknown => {
    if (!built.has(ctx)) {
      // Erasure seam: each factory was typed against these deps by `.usecases()`.
      built.set(ctx, state.usecases === undefined ? {} : state.usecases(ctx as never));
    }
    return built.get(ctx);
  };
  const servicesOf = (ctx: object): object => ({ ...ctx, usecases: usecasesOf(ctx) });

  const factories: Record<string, (ctx: object) => unknown> = {
    [usecasesKey]: usecasesOf,
    // One record under `feature.<name>`, keyed by entrypoint key — what `sliceOf` reads.
    [sliceKey]: ctx => {
      const services = servicesOf(ctx);
      // Erasure seam: each entrypoint was typed against these services by `.entrypoints()`.
      return Object.fromEntries(entrypoints.map(e => [e.key, e.resolve(services as never)]));
    },
  };
  for (const [key, factory] of Object.entries(state.provides)) {
    // Erasure seam: each factory was typed against these services by `.provides()`.
    factories[key] = ctx => factory(servicesOf(ctx) as never);
  }

  const unitHandles: Record<string, Handle<unknown, string>> = {};
  for (const key of Object.keys(factories)) unitHandles[key] = handleOf(key, state.name);
  // The record plugin() builds, written out: the needs here are already handles, and the keys already wire keys.
  const unit: AnyPlugin = {
    name: state.name,
    needs: { ...state.needs, ...infra.handles },
    actions: entrypoints.flatMap(e => [...e.actions, ...(e.actionsOf?.(state.name) ?? [])]),
    renames: {},
    role: 'feature',
    provides: unitHandles,
    factories,
    hooks: {},
  };
  const units: readonly AnyPlugin[] = [...infra.units, unit];

  const provides: Record<string, AnyHandle> = {};
  for (const key of Object.keys(state.provides)) provides[key] = handleOf(key, state.name);
  const rpc = entrypoints.find(e => e.kind === 'rpc');

  return {
    name: state.name,
    handles,
    provides,
    entrypoints,
    contract: rpc !== undefined && 'contract' in rpc ? rpc.contract : undefined,
    router: rpc !== undefined && 'router' in rpc ? rpc.router : undefined,
    plugins: () => units,
    override: values => {
      const used = new Set<string>();
      const replaced = state.infra.map(p => replaceServices(p, values, used));
      for (const key of Object.keys(values)) {
        if (!used.has(key)) {
          throw new FeatureError({
            code: FEATURE_ERROR_CODES.unknownOverride,
            message: `[feature] "${state.name}": override("${key}") names no service of its infra plugins.`,
            remediation: `Override one of: ${state.infra.flatMap(p => Object.keys(p.provides)).join(', ') || '(no infra)'}.`,
          });
        }
      }
      const next = { ...state, infra: replaced };
      return compile(next, qualifyInfra(next.name, next.infra), handles, entrypoints);
    },
  };
}

function stage(state: FeatureState): RuntimeStage {
  const infra = qualifyInfra(state.name, state.infra);
  const handles: NeedsShape = {
    ...state.needs,
    ...infra.handles,
    usecases: handleOf(`${state.name}.usecases`, state.name),
  };
  return {
    name: state.name,
    handles,
    needs: needs => {
      for (const alias of Object.keys(needs)) {
        if (RESERVED.has(alias)) {
          throw collision(state.name, `need alias "${alias}" is reserved`, 'Pick another alias for this need.');
        }
      }
      return stage({ ...state, needs });
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
      return stage({ ...state, infra: plugins });
    },
    usecases: factories =>
      stage({
        ...state,
        // One object, one key per factory, each built from the same deps.
        usecases: deps => Object.fromEntries(Object.entries(factories).map(([key, create]) => [key, create(deps)])),
      }),
    provides: factories => {
      for (const key of Object.keys(factories)) {
        if (RESERVED.has(key) || key === `${state.name}.usecases` || key === `feature.${state.name}`) {
          throw collision(state.name, `provided service "${key}" uses a reserved key`, 'Rename the provided service.');
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
  return stage({ name, needs: {}, infra: [], usecases: undefined, provides: {} }) as unknown as NeedsStage<TName>;
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
