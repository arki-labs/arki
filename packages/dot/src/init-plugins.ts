import type { ScopePlan } from '@arki/async';
import type { Failure } from '@arki/failure';

import type {
  ActionSource,
  BootGuard,
  CheckedProvider,
  CtxOf,
  DotConfigureContext,
  EmptyShape,
  InferredOwnership,
  KernelCtx,
  NeedsShape,
  NoReservedKeys,
  Plugin,
  ProvidedValues,
  Service,
  ServiceRecord,
  WireNeeds,
} from './plugin-contract.js';
import { createPlugin as definePlugin, service } from './plugin-contract.js';

type MaybePromise<T> = T | Promise<T>;
type ServiceKey<TServices extends object> = Extract<keyof TServices, string>;
type ServiceKeys<TServices extends object> = readonly ServiceKey<TServices>[];

type PickServices<TServices extends object, TKeys extends ServiceKeys<TServices>> = {
  readonly [K in TKeys[number]]: TServices[K];
};

type WitnessesFor<TServices extends object, TKeys extends ServiceKeys<TServices>> = {
  readonly [K in TKeys[number]]: Service<TServices[K]>;
};

type SchemaCheckedProvides<TServices extends object, TProvides extends ServiceRecord> = {
  readonly [K in keyof TProvides]: K extends keyof TServices
    ? ProvidedValues<TProvides>[K] extends TServices[K]
      ? TProvides[K]
      : never
    : TProvides[K];
};

/** One factory per published key, each checked against the context's service schema. */
type CheckedFactories<TCtx, TServices extends object, TProvides extends ServiceRecord> = {
  readonly [K in keyof TProvides]: (
    ctx: TCtx & KernelCtx,
  ) => TProvides[K] & SchemaCheckedProvides<TServices, NoInfer<TProvides>>[K] & CheckedProvider<NoInfer<TProvides[K]>>;
};

type CommonPluginDefinition = {
  readonly name: string;
  readonly actions?: readonly ActionSource[];
  readonly configure?: (ctx: DotConfigureContext) => void;
};

type KeyArrayPluginDefinition<
  TServices extends object,
  TKeys extends ServiceKeys<TServices>,
  TProvides extends ServiceRecord & NoReservedKeys,
  TBoot extends void | ScopePlan | Failure = void,
> = CommonPluginDefinition & {
  readonly needs?: TKeys;
  readonly provides?: CheckedFactories<PickServices<TServices, TKeys>, TServices, TProvides>;
  readonly boot?: (ctx: PickServices<TServices, TKeys> & ProvidedValues<TProvides> & KernelCtx) => MaybePromise<TBoot>;
  readonly start?: (ctx: PickServices<TServices, TKeys> & ProvidedValues<TProvides> & KernelCtx) => MaybePromise<void>;
  readonly stop?: (ctx: PickServices<TServices, TKeys> & ProvidedValues<TProvides> & KernelCtx) => MaybePromise<void>;
  readonly dispose?: (
    ctx: PickServices<TServices, TKeys> & ProvidedValues<TProvides> & KernelCtx,
  ) => MaybePromise<void>;
};

type WitnessPluginDefinition<
  TServices extends object,
  TShape extends NeedsShape & NoReservedKeys,
  TProvides extends ServiceRecord & NoReservedKeys,
  TBoot extends void | ScopePlan | Failure = void,
> = CommonPluginDefinition & {
  readonly needs: TShape;
  readonly provides?: CheckedFactories<CtxOf<TShape>, TServices, TProvides>;
  readonly boot?: (ctx: CtxOf<TShape> & ProvidedValues<TProvides> & KernelCtx) => MaybePromise<TBoot>;
  readonly start?: (ctx: CtxOf<TShape> & ProvidedValues<TProvides> & KernelCtx) => MaybePromise<void>;
  readonly stop?: (ctx: CtxOf<TShape> & ProvidedValues<TProvides> & KernelCtx) => MaybePromise<void>;
  readonly dispose?: (ctx: CtxOf<TShape> & ProvidedValues<TProvides> & KernelCtx) => MaybePromise<void>;
};

export type InitPluginsFactory<TServices extends object> = ReturnType<typeof createPluginFactory<TServices>>;

type ErasedPluginDefinition<
  TServices extends object,
  TProvides extends ServiceRecord & NoReservedKeys = ServiceRecord & NoReservedKeys,
  TBoot extends void | ScopePlan | Failure = void | ScopePlan | Failure,
> =
  | KeyArrayPluginDefinition<TServices, ServiceKeys<TServices>, TProvides, TBoot>
  | WitnessPluginDefinition<TServices, NeedsShape & NoReservedKeys, TProvides, TBoot>;

type KernelPluginDefinition<
  TProvides extends ServiceRecord & NoReservedKeys,
  TBoot extends void | ScopePlan | Failure,
> = Parameters<typeof definePlugin<NeedsShape & NoReservedKeys, TProvides, string, TBoot>>[0];

function needsFor<TServices extends object, const TKeys extends ServiceKeys<TServices>>(
  keys: TKeys,
): WitnessesFor<TServices, TKeys> {
  const needs: Record<string, Service<unknown>> = {};
  for (const key of keys) {
    needs[key] = service<TServices[typeof key]>();
  }
  return needs as WitnessesFor<TServices, TKeys>;
}

function isServiceKeyArray<TServices extends object>(
  needs: ErasedPluginDefinition<TServices>['needs'],
): needs is ServiceKeys<TServices> {
  return Array.isArray(needs);
}

function createPluginFactory<TServices extends object>() {
  function plugin<
    const TKeys extends ServiceKeys<TServices> = readonly [],
    TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
    TBoot extends void | ScopePlan | Failure = void,
  >(
    def: KeyArrayPluginDefinition<TServices, TKeys, TProvides, TBoot>,
    ...guard: BootGuard<NoInfer<TBoot>>
  ): Plugin<
    PickServices<TServices, TKeys>,
    ProvidedValues<TProvides>,
    WitnessesFor<TServices, TKeys>,
    string,
    InferredOwnership<TProvides, Awaited<TBoot>>
  >;
  function plugin<
    TShape extends NeedsShape & NoReservedKeys,
    TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
    TBoot extends void | ScopePlan | Failure = void,
  >(
    def: WitnessPluginDefinition<TServices, TShape, TProvides, TBoot>,
    ...guard: BootGuard<NoInfer<TBoot>>
  ): Plugin<WireNeeds<TShape>, ProvidedValues<TProvides>, TShape, string, InferredOwnership<TProvides, Awaited<TBoot>>>;
  function plugin<TProvides extends ServiceRecord & NoReservedKeys, TBoot extends void | ScopePlan | Failure>(
    def: ErasedPluginDefinition<TServices, TProvides, TBoot>,
  ) {
    const rawNeeds = def.needs;
    const needs = isServiceKeyArray<TServices>(rawNeeds)
      ? needsFor<TServices, ServiceKeys<TServices>>(rawNeeds)
      : rawNeeds;
    // Factory seam: key-array authoring is runtime-compiled to the same
    // witness record that the kernel already understands.
    const kernelDef: KernelPluginDefinition<TProvides, TBoot> = {
      name: def.name,
      ...(needs === undefined ? {} : { needs }),
      ...(def.actions === undefined ? {} : { actions: def.actions }),
      ...(def.configure === undefined ? {} : { configure: def.configure }),
      ...(def.provides === undefined
        ? {}
        : { provides: def.provides as KernelPluginDefinition<TProvides, TBoot>['provides'] }),
      ...(def.boot === undefined ? {} : { boot: def.boot as KernelPluginDefinition<TProvides, TBoot>['boot'] }),
      ...(def.start === undefined ? {} : { start: def.start as KernelPluginDefinition<TProvides, TBoot>['start'] }),
      ...(def.stop === undefined ? {} : { stop: def.stop as KernelPluginDefinition<TProvides, TBoot>['stop'] }),
      ...(def.dispose === undefined
        ? {}
        : { dispose: def.dispose as KernelPluginDefinition<TProvides, TBoot>['dispose'] }),
    };
    return definePlugin<NeedsShape & NoReservedKeys, TProvides, string, TBoot>(kernelDef);
  }
  function needs<const TKeys extends ServiceKeys<TServices>>(...keys: TKeys): WitnessesFor<TServices, TKeys> {
    return needsFor<TServices, typeof keys>(keys);
  }
  return { plugin, needs };
}

export const initPlugins = {
  context<TServices extends object>() {
    return {
      create(): InitPluginsFactory<TServices> {
        return createPluginFactory<TServices>();
      },
    };
  },
};
