import type { ScopePlan } from '@arki/async';
import type { Failure } from '@arki/failure';

import type {
  ActionSource,
  AuthoredUnit,
  BootGuard,
  CheckedProvider,
  CtxOf,
  DotLoggingHandle,
  EmptyHookReturns,
  EmptyShape,
  HookReturns,
  InferredPhases,
  KernelCtx,
  LoggingSlot,
  NeedsShape,
  NoReservedKeys,
  PhaseHooks,
  UnitDefinition,
  ProvidedValues,
  Service,
  ServiceRecord,
  WireNeeds,
} from './unit-contract.js';
import { createUnit as defineUnit, service } from './unit-contract.js';

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

type CommonUnitDefinition = {
  readonly name: string;
  readonly actions?: readonly ActionSource[];
};

type KeyArrayUnitDefinition<
  TServices extends object,
  TKeys extends ServiceKeys<TServices>,
  TProvides extends ServiceRecord & NoReservedKeys,
  TBoot extends undefined | ScopePlan | Failure = undefined,
  TReturns extends HookReturns = EmptyHookReturns,
  TLogging extends DotLoggingHandle | Failure = DotLoggingHandle<undefined>,
> = CommonUnitDefinition &
  LoggingSlot<TLogging> &
  PhaseHooks<PickServices<TServices, TKeys> & ProvidedValues<NoInfer<TProvides>> & KernelCtx, TReturns> & {
    readonly needs?: TKeys;
    readonly provides?: CheckedFactories<PickServices<TServices, TKeys>, TServices, TProvides>;
    readonly boot?: (
      ctx: PickServices<TServices, TKeys> & ProvidedValues<NoInfer<TProvides>> & KernelCtx,
    ) => MaybePromise<TBoot>;
  };

type WitnessUnitDefinition<
  TServices extends object,
  TShape extends NeedsShape & NoReservedKeys,
  TProvides extends ServiceRecord & NoReservedKeys,
  TBoot extends undefined | ScopePlan | Failure = undefined,
  TReturns extends HookReturns = EmptyHookReturns,
  TLogging extends DotLoggingHandle | Failure = DotLoggingHandle<undefined>,
> = CommonUnitDefinition &
  LoggingSlot<TLogging> &
  PhaseHooks<CtxOf<TShape> & ProvidedValues<NoInfer<TProvides>> & KernelCtx, TReturns> & {
    readonly needs: TShape;
    readonly provides?: CheckedFactories<CtxOf<TShape>, TServices, TProvides>;
    readonly boot?: (ctx: CtxOf<TShape> & ProvidedValues<NoInfer<TProvides>> & KernelCtx) => MaybePromise<TBoot>;
  };

export type InitUnitsFactory<TServices extends object> = ReturnType<typeof createUnitFactory<TServices>>;

type ErasedUnitDefinition<
  TServices extends object,
  TProvides extends ServiceRecord & NoReservedKeys = ServiceRecord & NoReservedKeys,
  TBoot extends undefined | ScopePlan | Failure = undefined | ScopePlan | Failure,
  TReturns extends HookReturns = HookReturns,
  TLogging extends DotLoggingHandle | Failure = DotLoggingHandle | Failure,
> =
  | KeyArrayUnitDefinition<TServices, ServiceKeys<TServices>, TProvides, TBoot, TReturns, TLogging>
  | WitnessUnitDefinition<TServices, NeedsShape & NoReservedKeys, TProvides, TBoot, TReturns, TLogging>;

type KernelUnitDefinition<
  TProvides extends ServiceRecord & NoReservedKeys,
  TBoot extends undefined | ScopePlan | Failure,
  TReturns extends HookReturns,
  TLogging extends DotLoggingHandle | Failure,
> = UnitDefinition<NeedsShape & NoReservedKeys, TProvides, string, TBoot, TReturns, TLogging>;

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
  needs: ErasedUnitDefinition<TServices>['needs'],
): needs is ServiceKeys<TServices> {
  return Array.isArray(needs);
}

function createUnitFactory<TServices extends object>() {
  function infra<
    const TKeys extends ServiceKeys<TServices> = readonly [],
    TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
    TBoot extends undefined = undefined,
  >(
    def: KeyArrayUnitDefinition<
      TServices,
      TKeys,
      TProvides,
      undefined,
      EmptyHookReturns,
      DotLoggingHandle<undefined>
    >,
    ...guard: BootGuard<NoInfer<TBoot>>
  ): AuthoredUnit<
    PickServices<TServices, TKeys>,
    ProvidedValues<TProvides>,
    WitnessesFor<TServices, TKeys>,
    string,
    TProvides,
    InferredPhases<EmptyHookReturns>,
    DotLoggingHandle<undefined>,
    TBoot
  >;
  function infra<
    const TKeys extends ServiceKeys<TServices> = readonly [],
    TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
    TBoot extends undefined | ScopePlan | Failure = undefined,
    TConfigure extends undefined | Failure = undefined,
    TStart extends undefined | Failure = undefined,
    TStop extends undefined | Failure = undefined,
    TDispose extends undefined | Failure = undefined,
    TLogging extends DotLoggingHandle | Failure = DotLoggingHandle<undefined>,
  >(
    def: KeyArrayUnitDefinition<
      TServices,
      TKeys,
      TProvides,
      TBoot,
      { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
      TLogging
    >,
    ...guard: BootGuard<NoInfer<TBoot>>
  ): AuthoredUnit<
    PickServices<TServices, TKeys>,
    ProvidedValues<TProvides>,
    WitnessesFor<TServices, TKeys>,
    string,
    TProvides,
    InferredPhases<{ configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose }>,
    TLogging,
    TBoot
  >;
  function infra<
    TShape extends NeedsShape & NoReservedKeys,
    TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
    TBoot extends undefined = undefined,
  >(
    def: WitnessUnitDefinition<
      TServices,
      TShape,
      TProvides,
      undefined,
      EmptyHookReturns,
      DotLoggingHandle<undefined>
    >,
    ...guard: BootGuard<NoInfer<TBoot>>
  ): AuthoredUnit<
    WireNeeds<TShape>,
    ProvidedValues<TProvides>,
    TShape,
    string,
    TProvides,
    InferredPhases<EmptyHookReturns>,
    DotLoggingHandle<undefined>,
    TBoot
  >;
  function infra<
    TShape extends NeedsShape & NoReservedKeys,
    TProvides extends ServiceRecord & NoReservedKeys = EmptyShape,
    TBoot extends undefined | ScopePlan | Failure = undefined,
    TConfigure extends undefined | Failure = undefined,
    TStart extends undefined | Failure = undefined,
    TStop extends undefined | Failure = undefined,
    TDispose extends undefined | Failure = undefined,
    TLogging extends DotLoggingHandle | Failure = DotLoggingHandle<undefined>,
  >(
    def: WitnessUnitDefinition<
      TServices,
      TShape,
      TProvides,
      TBoot,
      { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
      TLogging
    >,
    ...guard: BootGuard<NoInfer<TBoot>>
  ): AuthoredUnit<
    WireNeeds<TShape>,
    ProvidedValues<TProvides>,
    TShape,
    string,
    TProvides,
    InferredPhases<{ configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose }>,
    TLogging,
    TBoot
  >;
  function infra<
    TProvides extends ServiceRecord & NoReservedKeys,
    TBoot extends undefined | ScopePlan | Failure,
    TConfigure extends undefined | Failure = undefined,
    TStart extends undefined | Failure = undefined,
    TStop extends undefined | Failure = undefined,
    TDispose extends undefined | Failure = undefined,
    TLogging extends DotLoggingHandle | Failure = DotLoggingHandle<undefined>,
  >(
    def: ErasedUnitDefinition<
      TServices,
      TProvides,
      TBoot,
      { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
      TLogging
    >,
  ) {
    const rawNeeds = def.needs;
    const needs = isServiceKeyArray<TServices>(rawNeeds)
      ? needsFor<TServices, ServiceKeys<TServices>>(rawNeeds)
      : rawNeeds;
    // Factory seam: key-array authoring is runtime-compiled to the same
    // witness record that the kernel already understands.
    const kernelDef: KernelUnitDefinition<
      TProvides,
      TBoot,
      { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
      TLogging
    > = {
      name: def.name,
      ...(needs === undefined ? {} : { needs }),
      ...(def.actions === undefined ? {} : { actions: def.actions }),
      ...(def.logging === undefined ? {} : { logging: def.logging }),
      ...(def.configure === undefined ? {} : { configure: def.configure }),
      ...(def.provides === undefined
        ? {}
        : {
            provides: def.provides as KernelUnitDefinition<
              TProvides,
              TBoot,
              { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
              TLogging
            >['provides'],
          }),
      ...(def.boot === undefined
        ? {}
        : {
            boot: def.boot as KernelUnitDefinition<
              TProvides,
              TBoot,
              { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
              TLogging
            >['boot'],
          }),
      ...(def.start === undefined
        ? {}
        : {
            start: def.start as KernelUnitDefinition<
              TProvides,
              TBoot,
              { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
              TLogging
            >['start'],
          }),
      ...(def.stop === undefined
        ? {}
        : {
            stop: def.stop as KernelUnitDefinition<
              TProvides,
              TBoot,
              { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
              TLogging
            >['stop'],
          }),
      ...(def.dispose === undefined
        ? {}
        : {
            dispose: def.dispose as KernelUnitDefinition<
              TProvides,
              TBoot,
              { configure: TConfigure; start: TStart; stop: TStop; dispose: TDispose },
              TLogging
            >['dispose'],
          }),
    };
    return defineUnit<
      NeedsShape & NoReservedKeys,
      TProvides,
      string,
      TBoot,
      TConfigure,
      TStart,
      TStop,
      TDispose,
      TLogging
    >(kernelDef);
  }
  function needs<const TKeys extends ServiceKeys<TServices>>(...keys: TKeys): WitnessesFor<TServices, TKeys> {
    return needsFor<TServices, typeof keys>(keys);
  }
  return { infra, needs };
}

export const initUnits = {
  context<TServices extends object>() {
    return {
      create(): InitUnitsFactory<TServices> {
        return createUnitFactory<TServices>();
      },
    };
  },
};
