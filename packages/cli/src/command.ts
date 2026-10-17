/**
 * `defineCommand` and the types a command is written with. A command's types
 * are written once, in its input schema and its `run`, and inferred
 * everywhere else: `InputOf`, `OutputOf`, `ServicesOf`.
 */
import type { Failure } from '@arki/failure';
import type { Logger } from '@arki/log';
import type { SchemaInput, SchemaOutput, SchemaWithJson } from '@arki/schema';

import type { Ui } from './ui.js';

/** What a command does to the world: `read` changes nothing, `idempotent` is safe to repeat. */
export type Effects = 'read' | 'idempotent' | 'write';

/** How a run's result is written: text on a terminal, a JSON envelope, or one JSON line per item. */
export type Mode = 'text' | 'json' | 'ndjson';

/** The services of a command that runs outside a feature: none. */
export type NoServices = Readonly<Record<string, never>>;

/** The input of a command without an input schema: an empty object. */
export type NoInput = Readonly<Record<string, never>>;

/** The keys `args` and `ask` may name: the input's keys, or none without an input. */
export type InputKeys<TInput extends SchemaWithJson | undefined> = TInput extends SchemaWithJson
  ? keyof SchemaInput<TInput> & string
  : never;

/** What `run` and `preview` receive. `input` is already validated by the command's own schema. */
export type RunContext<TInput extends SchemaWithJson | undefined, TServices> = {
  /** The schema's output: defaults filled, transforms applied. Empty without an input. */
  readonly input: TInput extends SchemaWithJson ? SchemaOutput<TInput> : NoInput;
  /** None for a standalone command; the feature's services under Dot. */
  readonly services: TServices;
  /** Text to the person at the terminal. Silent in json and ndjson mode. */
  readonly ui: Ui;
  readonly mode: Mode;
  /** Aborted on SIGINT or SIGTERM. A run that ends after the abort is reported as `cli.cancelled`. */
  readonly signal: AbortSignal;
  /** `getLogger('arki:cli:<path>')`. */
  readonly log: Logger;
};

/** The success value of a `run` result: awaited, failures removed (`SuccessOf` in `@arki/failure`). */
export type Success<TResult> = Exclude<Awaited<TResult>, Failure>;

/**
 * One command. `TResult` is what `run` returns as written (a value,
 * failures, maybe a promise); `OutputOf` is its success value.
 */
export type Command<TInput extends SchemaWithJson | undefined, TResult, TServices> = {
  /** One line: what the command does. Shown in help. */
  readonly describe: string;
  /** An object schema with JSON Schema (Zod 4, Valibot, ArkType): it drives flags, coercion and validation. */
  readonly input?: TInput;
  /** Describes what `run` succeeds with; a mismatch with `run` is a compile error. */
  readonly output?: SchemaWithJson<unknown, Success<TResult>>;
  /** Input keys taken as positionals, in order. An array key may only be last. */
  readonly args?: readonly InputKeys<TInput>[];
  /** Default `'write'`. */
  readonly effects?: Effects;
  /** Prompt text per input key, asked on a terminal before validation. Accepted now; prompts are not built yet. */
  readonly ask?: Readonly<Partial<Record<InputKeys<TInput>, string>>>;
  /** A confirmation question. Accepted now; prompts are not built yet. */
  readonly confirm?: string;
  /** What `--dry-run` runs instead of `run`: the same input, the same success type, no changes. `NoInfer`: `run` alone decides the type. */
  preview?(
    ctx: RunContext<TInput, TServices>,
  ): NoInfer<Success<TResult>> | Failure | Promise<NoInfer<Success<TResult>> | Failure>;
  /*
   * Method syntax on purpose: method parameters are compared bivariantly, so
   * a tree can hold any command and the framework can call `run` with the
   * input it has just validated against this command's own schema.
   */
  run(ctx: RunContext<TInput, TServices>): TResult;
  /** Text mode only. Without it, an object prints as `key: value` lines and an array of objects as a table. */
  render?(data: Success<TResult>, ui: Ui): void;
  /** Command lines shown under "Examples" in help. */
  readonly examples?: readonly string[];
  /** Other names for this command at its level. */
  readonly aliases?: readonly string[];
  /** Left out of help listings; still runs. */
  readonly hidden?: boolean;
  /** Offered to MCP clients. Accepted now; the MCP server is not built yet. */
  readonly mcp?: boolean;
};

/** The context the framework passes to any command: input validated by that command's own schema. */
export type AnyRunContext<TServices> = Omit<RunContext<undefined, TServices>, 'input'> & { readonly input: unknown };

/** Any command whose `run` accepts these services: what a tree holds. */
export type AnyCommand<TServices = unknown> = {
  readonly describe: string;
  readonly input?: SchemaWithJson | undefined;
  readonly output?: SchemaWithJson | undefined;
  readonly args?: readonly string[];
  readonly effects?: Effects;
  readonly ask?: Readonly<Partial<Record<string, string>>>;
  readonly confirm?: string;
  preview?(ctx: AnyRunContext<TServices>): unknown;
  run(ctx: AnyRunContext<TServices>): unknown;
  render?(data: unknown, ui: Ui): void;
  readonly examples?: readonly string[];
  readonly aliases?: readonly string[];
  readonly hidden?: boolean;
  readonly mcp?: boolean;
};

/** A command's success value: what `run` returns, awaited, without its failures. */
export type OutputOf<C> = C extends { readonly run: (ctx: never) => infer R } ? Success<R> : never;

/** The context a command's `run` takes. */
type ContextOf<C> = C extends { readonly run: (ctx: infer Ctx) => unknown } ? Ctx : never;

/** A command's validated input. */
export type InputOf<C> = ContextOf<C> extends { readonly input: infer I } ? I : never;

/** The services a command's `run` reads. */
export type ServicesOf<C> = ContextOf<C> extends { readonly services: infer S } ? S : never;

/*
 * Two overloads, so a command without `input` fixes `TInput` to `undefined`.
 * With one signature, a command inside a tree would take `TInput` from the
 * tree's expected type (`SchemaWithJson | undefined`) and type its input as
 * `unknown`.
 */
/**
 * Define a command. Returns the definition unchanged; its types are inferred
 * from `input` and `run`, with no type argument.
 *
 * @example
 * export default defineCommand({
 *   describe: 'Greet someone',
 *   input: z.object({ name: z.string().default('world') }),
 *   run: ({ input }) => ({ greeting: `Hello, ${input.name}` }),
 * });
 */
export function defineCommand<TResult, TServices = NoServices>(
  def: Command<undefined, TResult, TServices> & { readonly input?: undefined },
): Command<undefined, TResult, TServices>;
export function defineCommand<TInput extends SchemaWithJson, TResult, TServices = NoServices>(
  def: Command<TInput, TResult, TServices>,
): Command<TInput, TResult, TServices>;
export function defineCommand<TInput extends SchemaWithJson | undefined, TResult, TServices>(
  def: Command<TInput, TResult, TServices>,
): Command<TInput, TResult, TServices> {
  return def;
}
