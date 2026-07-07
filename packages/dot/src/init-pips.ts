import type {
  CtxOf,
  DotConfigureContext,
  EmptyShape,
  InferredProvides,
  KernelCtx,
  NeedsShape,
  NoReservedKeys,
  Pip,
  ActionSource,
  Service,
  ServiceRecord,
  WireNeeds,
} from './pip-contract.js';
import { pip as definePip, service } from './pip-contract.js';

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

type CommonPipDefinition = {
  readonly name: string;
  readonly version?: string;
  readonly actions?: readonly ActionSource[];
  readonly configure?: (ctx: DotConfigureContext) => void;
};

type KeyArrayPipDefinition<
  TServices extends object,
  TKeys extends ServiceKeys<TServices>,
  TProvides extends ServiceRecord & NoReservedKeys,
> = CommonPipDefinition & {
  readonly needs?: TKeys;
  readonly boot?: (ctx: PickServices<TServices, TKeys> & KernelCtx) => MaybePromise<SchemaCheckedProvides<TServices, TProvides> | void>;
  readonly start?: (ctx: PickServices<TServices, TKeys> & TProvides & KernelCtx) => MaybePromise<void>;
  readonly stop?: (ctx: PickServices<TServices, TKeys> & TProvides & KernelCtx) => MaybePromise<void>;
  readonly dispose?: (ctx: PickServices<TServices, TKeys> & TProvides & KernelCtx) => MaybePromise<void>;
};

type WitnessPipDefinition<
  TServices extends object,
  TShape extends NeedsShape & NoReservedKeys,
  TProvides extends ServiceRecord & NoReservedKeys,
> = CommonPipDefinition & {
  readonly needs: TShape;
  readonly boot?: (ctx: CtxOf<TShape> & KernelCtx) => MaybePromise<SchemaCheckedProvides<TServices, TProvides> | void>;
  readonly start?: (ctx: CtxOf<TShape> & TProvides & KernelCtx) => MaybePromise<void>;
  readonly stop?: (ctx: CtxOf<TShape> & TProvides & KernelCtx) => MaybePromise<void>;
  readonly dispose?: (ctx: CtxOf<TShape> & TProvides & KernelCtx) => MaybePromise<void>;
};

export type InitPipsFactory<TServices extends object> = {
  pip<
    const TKeys extends ServiceKeys<TServices> = readonly [],
    TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
  >(
    def: KeyArrayPipDefinition<TServices, TKeys, TProvides>,
  ): Pip<PickServices<TServices, TKeys>, InferredProvides<TProvides>>;
  pip<TShape extends NeedsShape & NoReservedKeys, TProvides extends ServiceRecord & NoReservedKeys = EmptyShape>(
    def: WitnessPipDefinition<TServices, TShape, TProvides>,
  ): Pip<WireNeeds<TShape>, InferredProvides<TProvides>>;
  needs<const TKeys extends ServiceKeys<TServices>>(...keys: TKeys): WitnessesFor<TServices, TKeys>;
};

type ErasedPipDefinition<TServices extends object> =
  | KeyArrayPipDefinition<TServices, ServiceKeys<TServices>, ServiceRecord & NoReservedKeys>
  | WitnessPipDefinition<TServices, NeedsShape & NoReservedKeys, ServiceRecord & NoReservedKeys>;

type KernelPipDefinition = Parameters<
  typeof definePip<NeedsShape & NoReservedKeys, ServiceRecord & NoReservedKeys>
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
  needs: ErasedPipDefinition<TServices>['needs'],
): needs is ServiceKeys<TServices> {
  return Array.isArray(needs);
}

function createPipFactory<TServices extends object>(): InitPipsFactory<TServices> {
  const factory = {
    pip(def: ErasedPipDefinition<TServices>): Pip<ServiceRecord, ServiceRecord> {
      const rawNeeds = def.needs;
      const needs = isServiceKeyArray<TServices>(rawNeeds)
        ? needsFor<TServices, ServiceKeys<TServices>>(rawNeeds)
        : rawNeeds;
      // Factory seam: key-array authoring is runtime-compiled to the same
      // witness record that the kernel already understands.
      const kernelDef: KernelPipDefinition = {
        name: def.name,
        ...(def.version === undefined ? {} : { version: def.version }),
        ...(needs === undefined ? {} : { needs }),
        ...(def.actions === undefined ? {} : { actions: def.actions }),
        ...(def.configure === undefined ? {} : { configure: def.configure }),
        ...(def.boot === undefined ? {} : { boot: def.boot as KernelPipDefinition['boot'] }),
        ...(def.start === undefined ? {} : { start: def.start as KernelPipDefinition['start'] }),
        ...(def.stop === undefined ? {} : { stop: def.stop as KernelPipDefinition['stop'] }),
        ...(def.dispose === undefined ? {} : { dispose: def.dispose as KernelPipDefinition['dispose'] }),
      };
      return definePip(kernelDef) as unknown as Pip<ServiceRecord, ServiceRecord>;
    },
    needs<const TKeys extends ServiceKeys<TServices>>(...keys: TKeys): WitnessesFor<TServices, TKeys> {
      return needsFor<TServices, typeof keys>(keys);
    },
  };
  return factory as InitPipsFactory<TServices>;
}

export const initPips = {
  context<TServices extends object>() {
    return {
      create(): InitPipsFactory<TServices> {
        return createPipFactory<TServices>();
      },
    };
  },
};
