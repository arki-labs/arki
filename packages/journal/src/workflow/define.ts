/**
 * The workflow builder: `workflow(name, options).step(...).waitFor(...)...finish()`.
 * It builds a frozen definition and runs nothing. The definition carries the shape manifest
 * (names, kinds, order, undo flags), a hash of it, and the typed bodies for the runner.
 *
 * Types are written once, here. `results` grows by one key per node, and a node that can be
 * skipped (`when`) or can time out into `continue` adds `R | null`.
 */
import type { Failure } from '@arki/failure';
import type { Backoff } from '@arki/resilience';
import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';

import type { RetentionAge, RunRetention } from '../retention.js';
import type { AcceptFailure, BivariantFn, Needed, Needs, NoNeeds, RootDb, ServicesFor } from '../types.js';
import type { RunDetail } from './read.js';
import type { WorkflowShape } from './shape.js';
import { JournalError } from '../errors.js';
import { parseRunKeep } from '../retention.js';

/** What a node body sees. `results` has one key per earlier node. */
export type StepContext<Input, Results, N extends Needs = NoNeeds, AppDb = RootDb, Run = unknown> = Needed<N> & {
  readonly runId: string;
  readonly path: string;
  readonly attempt: number;
  readonly input: Input;
  readonly results: Results;
  /** This step's idempotency key. Stable across attempts and re-claims. */
  readonly key: string;
  /** Aborted on lease loss, stop, or the step's timeout. */
  readonly signal: AbortSignal;
  readonly db: AppDb;
  readonly run: Run;
  readonly accept: AcceptFailure;
};

/** The context as the runner builds it: nothing is known about the input or the results. */
export type ErasedContext = StepContext<unknown, Readonly<Record<string, unknown>>, Needs, unknown, unknown>;
/**
 * The library's claim for typed reads. The runner keeps a run's results erased (`results` by node name, `unknown`),
 * while `def.read` hands them out typed per node (`types.results`) and the output typed by the `output` schema
 * (`types.readOutput`). The compiler cannot connect the two, so the types rest on these facts:
 * - the runner stores at `results[K]` only what node K produced, after node K's own schema took it;
 * - the builder puts in `Checked` exactly the nodes `resultSchemaOf` finds a schema for, with that schema's output;
 * - `read` checks every stored result of such a node with that same schema, and a completed run's output with the
 *   `output` schema, before it gives them out.
 * This guard is the one place the claim is made. At run time it checks the last fact: that `read` did check each of
 * them (`checked` holds `output` and `results.<node>`). The first two are the runner's and the builder's contract.
 */
export function isCheckedRead<Input, ReadOutput, ReadResults extends AnyResults>(
  def: WorkflowDef<StandardSchemaV1, unknown, AnySignals, Needs, ReadOutput, ReadResults>,
  detail: RunDetail<Input>,
  checked: ReadonlySet<string>,
): detail is RunDetail<Input, ReadOutput, ReadResults> {
  const { run } = detail;
  if (def.output !== undefined && run.state === 'completed' && !checked.has('output')) return false;
  return def.nodes.every(
    node =>
      resultSchemaOf(node) === undefined ||
      !Object.hasOwn(run.results, node.name) ||
      checked.has(`results.${node.name}`),
  );
}

/** The schema a stored node result is checked with, and whether `null` (skipped, or timed out into `continue`) is kept. */
export function resultSchemaOf(node: WorkflowNode) {
  if (node.kind === 'step' && node.options.output !== undefined) {
    return { schema: node.options.output, nullable: node.options.when !== undefined };
  }
  if (node.kind === 'waitFor') return { schema: node.schema, nullable: node.onTimeout === 'continue' };
  return;
}

/** A stored body. Bivariant so a body typed for one workflow fits the erased slot without a cast. */
type Body<Out, Extra extends unknown[] = []> = BivariantFn<[...Extra, ctx: ErasedContext], Out>;

export type WorkflowNode =
  | {
      readonly kind: 'step';
      readonly name: string;
      readonly undo: boolean;
      readonly run: Body<unknown>;
      readonly options: {
        readonly output?: StandardSchemaV1;
        readonly undo?: BivariantFn<[ctx: ErasedContext & { readonly result: unknown }], unknown>;
        readonly key?: Body<string>;
        readonly retry?: Backoff;
        readonly timeout?: RetentionAge;
        readonly when?: Body<boolean>;
        /** An earlier node name, `'next'`, or a function that picks one. */
        readonly next?: string | BivariantFn<[ctx: ErasedContext & { readonly result: unknown }], string>;
      };
    }
  | {
      readonly kind: 'waitFor';
      readonly name: string;
      readonly undo: false;
      readonly signal: string;
      readonly schema: StandardSchemaV1;
      readonly timeout?: RetentionAge;
      readonly onTimeout: 'fail' | 'continue';
    }
  | {
      readonly kind: 'sleep';
      readonly name: string;
      readonly undo: false;
      readonly until: RetentionAge | Body<Date>;
    }
  | {
      readonly kind: 'child';
      readonly name: string;
      /** True when the node has an `undo` of its own, which then replaces compensating the child run. */
      readonly undo: boolean;
      readonly def: WorkflowDef | Body<WorkflowDef>;
      readonly input: Body<unknown>;
      readonly onCancel: 'cancel' | 'detach';
      readonly options: {
        readonly undo?: BivariantFn<[ctx: ErasedContext & { readonly result: unknown }], unknown>;
      };
    }
  | {
      readonly kind: 'map';
      readonly name: string;
      readonly undo: false;
      readonly def: WorkflowDef;
      readonly items: Body<readonly unknown[]>;
      readonly input: BivariantFn<[ctx: ErasedContext, item: unknown, index: number], unknown>;
      readonly wait: 'all' | 'any';
      readonly concurrency?: number;
    };

export type WorkflowLimits = {
  readonly payload: number;
  readonly transitions: number;
  readonly children: number;
};

/** The signals a workflow waits for: each signal name with the schema of its payload. */
export type AnySignals = Readonly<Record<string, StandardSchemaV1>>;
export type NoSignals = Readonly<Record<never, never>>;

/**
 * The finished definition. `types` is a phantom: it carries the output type and the signals, and holds no value.
 * `Signals` defaults to any signal map, so a bare `WorkflowDef` accepts every definition.
 */
export type WorkflowDef<
  Input extends StandardSchemaV1 = StandardSchemaV1,
  Output = unknown,
  Signals extends AnySignals = AnySignals,
  N extends Needs = Needs,
  ReadOutput = unknown,
  ReadResults extends AnyResults = AnyResults,
> = {
  readonly name: string;
  readonly version: number;
  readonly shape: WorkflowShape;
  readonly shapeHash: string;
  readonly input: Input;
  /** The declared output schema, if any. */
  readonly output: StandardSchemaV1 | undefined;
  readonly deadline: RetentionAge | undefined;
  readonly concurrency:
    | {
        readonly key: BivariantFn<[input: unknown], string>;
        readonly limit: number;
        readonly onBusy: 'refuse' | 'join';
      }
    | undefined;
  readonly onDeadStep: 'wait' | 'compensate';
  /** The workflow's own run retention; a field left out takes the journal's (`retention.workflows`). */
  readonly retention: RunRetention;
  readonly limits: WorkflowLimits;
  readonly needs: Needs;
  readonly nodes: readonly WorkflowNode[];
  /** Without a body, the run's output is the last node's result. */
  readonly finish: BivariantFn<[ctx: Pick<ErasedContext, 'runId' | 'input' | 'results'>], unknown> | undefined;
  /** `readOutput` and `results` are what `def.read` gives after its checks; see `CheckedRead`. */
  readonly types?: {
    readonly output: Output;
    readonly signals: Signals;
    readonly needs: N;
    readonly readOutput: ReadOutput;
    readonly results: ReadResults;
  };
};

/** The needs a workflow definition declared, read from its type: written once, in `workflow(name, { needs })`. */
type NeedsOfDef<D> = D extends { readonly types?: { readonly needs: infer N extends Needs } } ? N : Needs;

/**
 * What a list of workflows needs, as one object of services, like `ServicesFor` does for effects. `compose` and the
 * Dot adapter both check a workflow's services with it.
 */
export type WorkflowServices<W extends readonly WorkflowDef[]> = ServicesFor<{
  readonly [K in keyof W]: { readonly needs: NeedsOfDef<W[K]> };
}>;

export type WorkflowOptions<
  Input extends StandardSchemaV1,
  N extends Needs,
  Output extends StandardSchemaV1 | undefined,
> = {
  readonly version: number;
  readonly input: Input;
  readonly output?: Output;
  readonly deadline?: RetentionAge;
  readonly concurrency?: {
    readonly key: (input: SchemaOutput<Input>) => string;
    readonly limit: number;
    readonly onBusy: 'refuse' | 'join';
  };
  readonly onDeadStep?: 'wait' | 'compensate';
  /** How long the run row stays after it ends, by how it ended. Overrides `retention.workflows` of `initJournal`. */
  readonly retention?: RunRetention;
  readonly limits?: Partial<WorkflowLimits>;
  readonly needs?: N;
};

/** Results by node name, as the runner stores them. */
export type AnyResults = Readonly<Record<string, unknown>>;
export type NoResults = Readonly<Record<never, never>>;
/** `Results` plus one key. Written as a mapped type so the shape prints and compares flat. */
type Add<Results extends AnyResults, Name extends string, Value> = {
  readonly [K in keyof Results | Name]: K extends Name ? Value : K extends keyof Results ? Results[K] : never;
};
/** The step name itself, or `never` when an earlier node already uses it. */
type Fresh<Results extends AnyResults, Name extends string> = Name extends keyof Results ? never : Name;
/** What a step really produced: the awaited value without a returned `Failure`. */
type Resolved<Returned> = Exclude<Awaited<Returned>, Failure>;
type Host = { readonly db: unknown; readonly run: unknown };
type OutputOf<Def extends WorkflowDef> = NonNullable<Def['types']>['output'];
/** `Signals` plus one signal. A name used twice keeps the later schema; `define` refuses two different schemas for one name. */
type AddSignal<Signals extends AnySignals, Name extends string, Payload extends StandardSchemaV1> = {
  readonly [K in keyof Signals | Name]: K extends Name ? Payload : K extends keyof Signals ? Signals[K] : never;
};

type StepOptions<Context, Result, Earlier extends string> = {
  /** Parses the stored result. Needed for an operator to supply a result by hand. */
  readonly output?: StandardSchemaV1<unknown, Result>;
  readonly undo?: (ctx: Context & { readonly result: Result }) => unknown;
  readonly key?: (ctx: Context) => string;
  readonly retry?: Backoff;
  readonly timeout?: RetentionAge;
  /** Backward jump only: an earlier node, or `'next'` to carry on. */
  readonly next?: Earlier | 'next' | ((ctx: Context & { readonly result: Result }) => Earlier | 'next');
};

export type WorkflowBuilder<
  Input extends StandardSchemaV1,
  Results extends AnyResults,
  N extends Needs,
  Declared extends StandardSchemaV1 | undefined,
  Last,
  Where extends Host,
  Ext extends DefExtension = NoExtension,
  Signals extends AnySignals = NoSignals,
  /** The nodes whose stored result `def.read` checks with a schema of the node, with the type that check gives. */
  Checked extends AnyResults = NoResults,
> = {
  step<
    Name extends string,
    Returned,
    When extends ((ctx: Ctx<Input, Results, N, Where>) => boolean) | undefined,
    Output extends StandardSchemaV1<unknown, Resolved<Returned>> | undefined = undefined,
  >(
    name: Fresh<Results, Name>,
    run: (ctx: Ctx<Input, Results, N, Where>) => Returned,
    // `NoInfer`: the result comes from the body alone. Inferred from `output` as well, the schema would win and an
    // async body (a promise of the result) would no longer match it.
    options?: StepOptions<Ctx<Input, Results, N, Where>, NoInfer<Resolved<Returned>>, keyof Results & string> & {
      /** When it returns false the step is skipped and its result is `null`. */
      readonly when?: When;
      readonly output?: Output;
    },
  ): WorkflowBuilder<
    Input,
    Add<Results, Name, StepResult<Returned, When>>,
    N,
    Declared,
    StepResult<Returned, When>,
    Where,
    Ext,
    Signals,
    [Output] extends [StandardSchemaV1] ? Add<Checked, Name, StepResult<SchemaOutput<Output>, When>> : Checked
  >;

  waitFor<
    Name extends string,
    Signal extends string,
    Payload extends StandardSchemaV1,
    OnTimeout extends 'fail' | 'continue' = 'fail',
  >(
    name: Fresh<Results, Name>,
    options: {
      /** The signal's name. One name has one payload schema: two waits for it must share the same schema object. */
      readonly signal: Signal;
      readonly schema: Payload;
      readonly timeout?: RetentionAge;
      readonly onTimeout?: OnTimeout;
    },
  ): WorkflowBuilder<
    Input,
    Add<Results, Name, Waited<Payload, OnTimeout>>,
    N,
    Declared,
    Waited<Payload, OnTimeout>,
    Where,
    Ext,
    AddSignal<Signals, Signal, Payload>,
    Add<Checked, Name, Waited<Payload, OnTimeout>>
  >;

  sleep<Name extends string>(
    name: Fresh<Results, Name>,
    until: RetentionAge | ((ctx: Ctx<Input, Results, N, Where>) => Date),
  ): WorkflowBuilder<Input, Add<Results, Name, null>, N, Declared, null, Where, Ext, Signals, Checked>;

  child<Name extends string, Def extends WorkflowDef>(
    name: Fresh<Results, Name>,
    def: Def | ((ctx: Ctx<Input, Results, N, Where>) => Def),
    options: {
      readonly input: (ctx: Ctx<Input, Results, N, Where>) => SchemaInput<Def['input']>;
      /** What a cancel of this run does to the child: cancel it (default) or leave it running. */
      readonly onCancel?: 'cancel' | 'detach';
      /** Undoes the node when the run compensates. Without it, the child run itself is compensated. */
      readonly undo?: (ctx: Ctx<Input, Results, N, Where> & { readonly result: OutputOf<Def> }) => unknown;
    },
  ): WorkflowBuilder<Input, Add<Results, Name, OutputOf<Def>>, N, Declared, OutputOf<Def>, Where, Ext, Signals, Checked>;

  map<Name extends string, Item, Def extends WorkflowDef, Wait extends 'all' | 'any' = 'all'>(
    name: Fresh<Results, Name>,
    def: Def,
    options: {
      readonly items: (ctx: Ctx<Input, Results, N, Where>) => readonly Item[];
      readonly input: (ctx: Ctx<Input, Results, N, Where>, item: Item, index: number) => SchemaInput<Def['input']>;
      readonly wait?: Wait;
      readonly concurrency?: number;
    },
  ): WorkflowBuilder<
    Input,
    Add<Results, Name, Wait extends 'any' ? OutputOf<Def> : OutputOf<Def>[]>,
    N,
    Declared,
    Wait extends 'any' ? OutputOf<Def> : OutputOf<Def>[],
    Where,
    Ext,
    Signals,
    Checked
  >;

  /**
   * Without a function the output is the last node's result. With an `output` schema the function must return that
   * schema's output (or a failure, or a promise of either): a wrong return does not compile. Without a function the
   * last result must fit the schema, or the function is required.
   */
  finish<Returned extends FinishBound<Declared> = Last>(
    ...run: [Last] extends [FinishBound<Declared>]
      ? [run?: (ctx: FinishContext<Input, Results>) => Returned]
      : [run: (ctx: FinishContext<Input, Results>) => Returned]
  ): WorkflowDef<
    Input,
    FinishOutput<Declared, Returned>,
    Signals,
    N,
    ReadOutputOf<Declared>,
    ReadResultsOf<Results, Checked>
  > &
    ApplyExtension<Ext, Signals, ReadOutputOf<Declared>, ReadResultsOf<Results, Checked>>;
};

/** A `waitFor` result: the payload, or `null` when the wait timed out into `continue`. */
type Waited<Payload extends StandardSchemaV1, OnTimeout> = OnTimeout extends 'continue'
  ? SchemaOutput<Payload> | null
  : SchemaOutput<Payload>;
/** What `def.read` gives as the output: the `output` schema's output, `unknown` without one. */
type ReadOutputOf<Declared extends StandardSchemaV1 | undefined> = [Declared] extends [StandardSchemaV1]
  ? SchemaOutput<Declared>
  : unknown;
/** What `def.read` gives as the results: a checked node has its schema's type, any other `unknown`. A node that has not run is missing. */
type ReadResultsOf<Results extends AnyResults, Checked extends AnyResults> = {
  readonly [K in keyof Results]?: K extends keyof Checked ? Checked[K] : unknown;
};

type StepResult<Returned, When> = undefined extends When ? Resolved<Returned> : Resolved<Returned> | null;
type FinishOutput<Declared extends StandardSchemaV1 | undefined, Returned> = [Declared] extends [StandardSchemaV1]
  ? SchemaOutput<Declared>
  : Resolved<Returned>;
/** What `finish` may return: with an `output` schema, its output or a failure, or a promise of either. */
type FinishBound<Declared extends StandardSchemaV1 | undefined> = [Declared] extends [StandardSchemaV1]
  ? SchemaOutput<Declared> | Failure | PromiseLike<SchemaOutput<Declared> | Failure>
  : unknown;

type Ctx<Input extends StandardSchemaV1, Results extends AnyResults, N extends Needs, Where extends Host> = StepContext<
  SchemaOutput<Input>,
  Results,
  N,
  Where['db'],
  Where['run']
>;
type FinishContext<Input extends StandardSchemaV1, Results extends AnyResults> = {
  readonly runId: string;
  readonly input: SchemaOutput<Input>;
  readonly results: Results;
};

const DEFAULT_LIMITS: WorkflowLimits = { payload: 65_536, transitions: 1000, children: 1000 };

/**
 * What a journal puts on a finished definition, such as `start` and `signal`, as a type-level function of the
 * definition's signals. The signals are only complete at `finish()`, after `workflow()` has fixed the extension,
 * so the extension is `out`, written in terms of `this['signals']`, and `ApplyExtension` fills the slot in.
 */
export type DefExtension = {
  readonly signals: unknown;
  readonly readOutput: unknown;
  readonly results: unknown;
  readonly out: object;
};
/** The extension that adds nothing. */
export type NoExtension = DefExtension & { readonly out: Record<never, never> };
/** What the extension `Ext` adds to a definition with the signals `Signals` and what `def.read` gives. */
export type ApplyExtension<Ext extends DefExtension, Signals extends AnySignals, ReadOutput, ReadResults> = (Ext & {
  readonly signals: Signals;
  readonly readOutput: ReadOutput;
  readonly results: ReadResults;
})['out'];

/** Adds what a journal puts on a finished definition. It sees the definition, with its signals, without the addition. */
type Attach<Input extends StandardSchemaV1, Ext extends DefExtension> = <
  Signals extends AnySignals,
  ReadOutput,
  ReadResults extends AnyResults,
>(
  def: WorkflowDef<Input, unknown, Signals, Needs, ReadOutput, ReadResults>,
) => ApplyExtension<Ext, Signals, ReadOutput, ReadResults>;

type BuilderState<Input extends StandardSchemaV1, Ext extends DefExtension> = {
  readonly attach: Attach<Input, Ext>;
  readonly name: string;
  readonly header: Omit<WorkflowDef<Input>, 'shape' | 'shapeHash' | 'nodes' | 'finish' | 'types'>;
  readonly nodes: readonly WorkflowNode[];
};

/** 64-bit hash of a string as 16 hex characters. Portable (no crypto); it detects drift, it is not a security hash. */
function hashText(text: string): string {
  let h1 = 3_735_928_559;
  let h2 = 1_103_547_991;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i) ?? 0;
    h1 = Math.imul(h1 ^ code, 2_654_435_761);
    h2 = Math.imul(h2 ^ code, 1_597_334_677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

function shapeOf(nodes: readonly WorkflowNode[]): WorkflowShape {
  return {
    nodes: nodes.map(node => ({
      name: node.name,
      kind: node.kind,
      undo: node.undo,
      ...(node.kind === 'child' ? { onCancel: node.onCancel } : {}),
      ...(node.kind === 'waitFor' ? { signal: node.signal } : {}),
    })),
  };
}

const isPositiveInt = (value: number) => Number.isInteger(value) && value > 0;

function refuse(workflowName: string, detail: string): never {
  throw new JournalError('BAD_DEFINITION', 'workflow', workflowName, `${workflowName}: ${detail}`);
}

/** Adds a node after checking the rules that need no types. */
function withNode<Input extends StandardSchemaV1, Ext extends DefExtension>(
  state: BuilderState<Input, Ext>,
  node: WorkflowNode,
): BuilderState<Input, Ext> {
  if (node.name === '') refuse(state.name, 'a node name must not be empty');
  if (node.name === 'next') refuse(state.name, "a node cannot be called 'next', because `next: 'next'` means carry on");
  if (state.nodes.some(existing => existing.name === node.name)) {
    refuse(state.name, `node '${node.name}' is declared twice; node names are unique per workflow`);
  }
  if (node.kind === 'step') {
    const { next } = node.options;
    if (typeof next === 'string' && next !== 'next' && !state.nodes.some(existing => existing.name === next)) {
      refuse(
        state.name,
        `step '${node.name}' has next: '${next}', which is not an earlier node; next may only jump back`,
      );
    }
  }
  return { ...state, nodes: [...state.nodes, node] };
}

function refuseUndo(workflowName: string, kind: string, name: string, options: object | undefined) {
  if (options !== undefined && 'undo' in options) {
    refuse(workflowName, `${kind} '${name}' cannot have an undo; only a step or a child can be undone`);
  }
}

function finishDef<
  Input extends StandardSchemaV1,
  Output,
  Signals extends AnySignals,
  N extends Needs,
  Ext extends DefExtension,
  ReadOutput,
  ReadResults extends AnyResults,
>(
  state: BuilderState<Input, Ext>,
  finish: WorkflowDef['finish'],
): WorkflowDef<Input, Output, Signals, N, ReadOutput, ReadResults> &
  ApplyExtension<Ext, Signals, ReadOutput, ReadResults> {
  if (state.nodes.length === 0) refuse(state.name, 'a workflow needs at least one node');
  const nodes = state.nodes.map(node => Object.freeze(node));
  const shape = shapeOf(nodes);
  const plain: WorkflowDef<Input, Output, Signals, N, ReadOutput, ReadResults> = {
    ...state.header,
    shape: Object.freeze({ nodes: Object.freeze(shape.nodes.map(entry => Object.freeze(entry))) }),
    shapeHash: hashText(JSON.stringify(shape.nodes.map(entry => [entry.name, entry.kind, entry.undo]))),
    nodes: Object.freeze(nodes),
    finish,
  };
  const def = { ...plain, ...state.attach(plain) };
  Object.freeze(def);
  return def;
}

/**
 * Each method returns this factory again, called with the grown type. The return type is
 * inferred from the interface's own signature, so the compiler checks every method against it.
 */
function makeBuilder<
  Input extends StandardSchemaV1,
  Results extends AnyResults,
  N extends Needs,
  Declared extends StandardSchemaV1 | undefined,
  Last,
  Where extends Host,
  Ext extends DefExtension,
  Signals extends AnySignals,
  Checked extends AnyResults,
>(
  state: BuilderState<Input, Ext>,
): WorkflowBuilder<Input, Results, N, Declared, Last, Where, Ext, Signals, Checked> {
  return {
    step: (name, run, options) =>
      makeBuilder(
        withNode(state, { kind: 'step', name, undo: options?.undo !== undefined, run, options: options ?? {} }),
      ),
    waitFor: (name, options) => {
      refuseUndo(state.name, 'waitFor', name, options);
      if (options.signal === '') refuse(state.name, `waitFor '${name}' needs a signal name`);
      const sharing = state.nodes.find(
        node => node.kind === 'waitFor' && node.signal === options.signal && node.schema !== options.schema,
      );
      if (sharing !== undefined) {
        refuse(
          state.name,
          `waitFor '${name}' and '${sharing.name}' both wait for signal '${options.signal}' with different schemas; one signal name has one payload schema, so share the schema object`,
        );
      }
      return makeBuilder(
        withNode(state, {
          kind: 'waitFor',
          name,
          undo: false,
          signal: options.signal,
          schema: options.schema,
          timeout: options.timeout,
          onTimeout: options.onTimeout ?? 'fail',
        }),
      );
    },
    sleep: (name, until, extra?: object) => {
      refuseUndo(state.name, 'sleep', name, extra);
      return makeBuilder(withNode(state, { kind: 'sleep', name, undo: false, until }));
    },
    child: (name, def, options) => {
      return makeBuilder(
        withNode(state, {
          kind: 'child',
          name,
          undo: options.undo !== undefined,
          def,
          input: options.input,
          onCancel: options.onCancel ?? 'cancel',
          options: { undo: options.undo },
        }),
      );
    },
    map: (name, def, options) => {
      refuseUndo(state.name, 'map', name, options);
      if (options.concurrency !== undefined && !isPositiveInt(options.concurrency)) {
        refuse(state.name, `map '${name}' needs a positive whole concurrency`);
      }
      return makeBuilder(
        withNode(state, {
          kind: 'map',
          name,
          undo: false,
          def,
          items: options.items,
          input: options.input,
          wait: options.wait ?? 'all',
          concurrency: options.concurrency,
        }),
      );
    },
    finish: run => finishDef(state, run),
  };
}

/**
 * Starts a workflow definition. The version and input schema are required; nodes follow.
 * Throws `BAD_DEFINITION`, naming the workflow, for a duplicate node name, a `next` that is not
 * an earlier node, an `undo` on anything but a step or a child, and a workflow with no node.
 */
export function workflow<
  Input extends StandardSchemaV1,
  N extends Needs = NoNeeds,
  Declared extends StandardSchemaV1 | undefined = undefined,
  Where extends Host = { readonly db: RootDb; readonly run: unknown },
>(
  name: string,
  options: WorkflowOptions<Input, N, Declared>,
): WorkflowBuilder<Input, NoResults, N, Declared, never, Where> {
  return workflowWith(name, options, () => ({}));
}

/**
 * `workflow` with a journal's additions: `attach` runs when `finish` builds the definition and
 * returns what to merge into it (`start`, from `j.workflow`). The builder types carry that as `Ext`.
 */
export function workflowWith<
  Input extends StandardSchemaV1,
  N extends Needs,
  Declared extends StandardSchemaV1 | undefined,
  Where extends Host,
  Ext extends DefExtension,
>(
  name: string,
  options: WorkflowOptions<Input, N, Declared>,
  attach: Attach<Input, Ext>,
): WorkflowBuilder<Input, NoResults, N, Declared, never, Where, Ext> {
  if (name === '') refuse(name, 'a workflow needs a name');
  if (!isPositiveInt(options.version)) refuse(name, `version must be a positive whole number, got ${options.version}`);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [limit, value] of Object.entries(limits)) {
    if (!isPositiveInt(value)) refuse(name, `limits.${limit} must be a positive whole number, got ${value}`);
  }
  const { concurrency } = options;
  if (concurrency !== undefined && !isPositiveInt(concurrency.limit)) {
    refuse(name, `concurrency.limit must be a positive whole number, got ${concurrency.limit}`);
  }
  for (const [outcome, keep] of Object.entries(options.retention ?? {})) {
    parseRunKeep(keep, `workflow "${name}": retention.${outcome}`);
  }
  return makeBuilder({
    attach,
    name,
    nodes: [],
    header: {
      name,
      version: options.version,
      input: options.input,
      output: options.output,
      deadline: options.deadline,
      concurrency,
      onDeadStep: options.onDeadStep ?? 'wait',
      retention: options.retention ?? {},
      limits,
      needs: options.needs ?? {},
    },
  });
}
