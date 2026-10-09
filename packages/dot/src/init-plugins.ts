import type {
  CtxOf,
  DotConfigureContext,
  EmptyShape,
  InferredProvides,
  KernelCtx,
  NeedsShape,
  NoReservedKeys,
  Plugin,
  ActionSource,
  Service,
  ServiceRecord,
  WireNeeds,
} from './plugin-contract.js';
import { plugin as definePlugin, service } from './plugin-contract.js';

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
    ? TProvides[K] extends TServices[K]
      ? TProvides[K]
      : never
    : TProvides[K];
};

type CommonPluginDefinition = {
  readonly name: string;
  readonly version?: string;
  readonly actions?: readonly ActionSource[];
  readonly configure?: (ctx: DotConfigureContext) => void;
};

type KeyArrayPluginDefinition<
  TServices extends object,
  TKeys extends ServiceKeys<TServices>,
  TProvides extends ServiceRecord & NoReservedKeys,
> = CommonPluginDefinition & {
  readonly needs?: TKeys;
  readonly boot?: (ctx: PickServices<TServices, TKeys> & KernelCtx) => MaybePromise<SchemaCheckedProvides<TServices, TProvides> | void>;
  readonly start?: (ctx: PickServices<TServices, TKeys> & TProvides & KernelCtx) => MaybePromise<void>;
  readonly stop?: (ctx: PickServices<TServices, TKeys> & TProvides & KernelCtx) => MaybePromise<void>;
  readonly dispose?: (ctx: PickServices<TServices, TKeys> & TProvides & KernelCtx) => MaybePromise<void>;
};

type WitnessPluginDefinition<
  TServices extends object,
  TShape extends NeedsShape & NoReservedKeys,
  TProvides extends ServiceRecord & NoReservedKeys,
> = CommonPluginDefinition & {
  readonly needs: TShape;
  readonly boot?: (ctx: CtxOf<TShape> & KernelCtx) => MaybePromise<SchemaCheckedProvides<TServices, TProvides> | void>;
  readonly start?: (ctx: CtxOf<TShape> & TProvides & KernelCtx) => MaybePromise<void>;
  readonly stop?: (ctx: CtxOf<TShape> & TProvides & KernelCtx) => MaybePromise<void>;
  readonly dispose?: (ctx: CtxOf<TShape> & TProvides & KernelCtx) => MaybePromise<void>;
};

export type InitPluginsFactory<TServices extends object> = {
  plugin<
    const TKeys extends ServiceKeys<TServices> = readonly [],
    TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
  >(
    def: KeyArrayPluginDefinition<TServices, TKeys, TProvides>,
  ): Plugin<PickServices<TServices, TKeys>, InferredProvides<TProvides>>;
  plugin<TShape extends NeedsShape & NoReservedKeys, TProvides extends ServiceRecord & NoReservedKeys = EmptyShape>(
    def: WitnessPluginDefinition<TServices, TShape, TProvides>,
  ): Plugin<WireNeeds<TShape>, InferredProvides<TProvides>>;
  needs<const TKeys extends ServiceKeys<TServices>>(...keys: TKeys): WitnessesFor<TServices, TKeys>;
};

type ErasedPluginDefinition<TServices extends object> =
  | KeyArrayPluginDefinition<TServices, ServiceKeys<TServices>, ServiceRecord & NoReservedKeys>
  | WitnessPluginDefinition<TServices, NeedsShape & NoReservedKeys, ServiceRecord & NoReservedKeys>;

type KernelPluginDefinition = Parameters<
  typeof definePlugin<NeedsShape & NoReservedKeys, ServiceRecord & NoReservedKeys>
>[0];

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

function createPluginFactory<TServices extends object>(): InitPluginsFactory<TServices> {
  const factory = {
    plugin(def: ErasedPluginDefinition<TServices>): Plugin<ServiceRecord, ServiceRecord> {
      const rawNeeds = def.needs;
      const needs = isServiceKeyArray<TServices>(rawNeeds)
        ? needsFor<TServices, ServiceKeys<TServices>>(rawNeeds)
        : rawNeeds;
      // Factory seam: key-array authoring is runtime-compiled to the same
      // witness record that the kernel already understands.
      const kernelDef: KernelPluginDefinition = {
        name: def.name,
        ...(def.version === undefined ? {} : { version: def.version }),
        ...(needs === undefined ? {} : { needs }),
        ...(def.actions === undefined ? {} : { actions: def.actions }),
        ...(def.configure === undefined ? {} : { configure: def.configure }),
        ...(def.boot === undefined ? {} : { boot: def.boot as KernelPluginDefinition['boot'] }),
        ...(def.start === undefined ? {} : { start: def.start as KernelPluginDefinition['start'] }),
        ...(def.stop === undefined ? {} : { stop: def.stop as KernelPluginDefinition['stop'] }),
        ...(def.dispose === undefined ? {} : { dispose: def.dispose as KernelPluginDefinition['dispose'] }),
      };
      return definePlugin(kernelDef) as unknown as Plugin<ServiceRecord, ServiceRecord>;
    },
    needs<const TKeys extends ServiceKeys<TServices>>(...keys: TKeys): WitnessesFor<TServices, TKeys> {
      return needsFor<TServices, typeof keys>(keys);
    },
  };
  return factory as InitPluginsFactory<TServices>;
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
