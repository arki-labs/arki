import type { StandardSchemaV1 } from '@arki/schema';

import type { Failure } from '@arki/failure';
import { InvalidInput, REVIVAL_FAILURES, UnexpectedDefect } from '@arki/failure';

import { Cancelled, ConnectionLost, isProviderFailure, PROVIDER_FAILURES } from '../failures.js';

/**
 * Agent-runtime adapter layer — neutral contracts.
 *
 * A bake-off across frameworks showed the
 * agentic tool-loop is a commodity across AI SDK / Mastra / LangChain / LangGraph / TanStack.
 * These types are the framework-neutral seam every backend adapts to, so the runtime choice
 * is swappable rather than load-bearing. See docs/arki/research/ai/adapter-layer-proposal.md.
 *
 * Scope discipline (the #1 failure mode is over-abstraction): this layer adapts ONLY the tool
 * contract and the run→event stream. It does NOT wrap framework-specific depth (memory, eval
 * harnesses, graph builders, generative UI) — a feature that needs those depends on them
 * directly.
 */

/** Token accounting for one run (fields may be undefined when a provider omits usage). */
export type RuntimeUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Normalized event stream emitted by every runtime adapter. Mirrors the existing `FlowEvent`
 * vocabulary (run/tool lifecycle) so UI adapters can consume one shape regardless of backend.
 */
export type RuntimeEvent =
  | { type: 'run:start' }
  | { type: 'text:delta'; delta: string }
  | { type: 'tool:start'; tool: string; args: unknown }
  | { type: 'tool:result'; tool: string; result: unknown }
  /** The tool returned a failure from `@arki/failure`; the model got `{ error: failure }` as the result. */
  | { type: 'tool:failure'; tool: string; failure: ToolFailure }
  | { type: 'tool:error'; tool: string; error: string }
  | { type: 'run:finish'; text: string; usage?: RuntimeUsage }
  /**
   * The run failed: the provider refused or broke off (`ProviderFailure`), the caller aborted
   * (`Cancelled`), or, on the client, the wire broke (`ConnectionLost`, a malformed frame). It is the
   * last event of a run: no `run:finish` follows it.
   */
  | { type: 'run:error'; failure: RuntimeFailure };

/**
 * Every failure a `run:error` can carry. It is also the allowlist the SSE transport serializes and
 * revives, so a failure keeps its code and data (a rate limit keeps its Retry-After) across the wire.
 */
export const RUNTIME_FAILURES = [
  ...PROVIDER_FAILURES,
  ConnectionLost,
  InvalidInput,
  ...REVIVAL_FAILURES,
] as const;

/** One of {@link RUNTIME_FAILURES}. */
export type RuntimeFailure = ReturnType<(typeof RUNTIME_FAILURES)[number]>;

/** An abort raised by `fetch` or a stream: a DOM `AbortError`, or the `TimeoutError` of `AbortSignal.timeout`. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** A broken connection to an AI endpoint: `Cancelled` when the caller aborted it, `ConnectionLost` otherwise. */
export function connectionFailure(error: unknown, signal?: AbortSignal | null): RuntimeFailure {
  return signal?.aborted || isAbortError(error) ? Cancelled({ cause: error }) : ConnectionLost({ cause: error });
}

/**
 * The failure for a value a run's source threw: an abort is `Cancelled`, a provider failure stays
 * itself, anything else is a bug (`UnexpectedDefect`).
 */
export function thrownRunFailure(error: unknown, signal?: AbortSignal): RuntimeFailure {
  if (signal?.aborted || isAbortError(error)) return Cancelled({ cause: error });
  if (isProviderFailure(error)) return error;
  return UnexpectedDefect({ cause: error });
}

/**
 * What the model receives, as `{ error: ToolFailure }`, when a tool returns a failure from
 * `@arki/failure`. The remediation tells the model how to correct its next call.
 */
export type ToolFailure = {
  code: string;
  message: string;
  remediation: string | undefined;
  data: unknown;
};

/** What a tool's `execute` receives besides its input. */
export type AgentToolExecuteOptions = {
  /**
   * Aborts when the run is cancelled. Pass it to `fetch` and other slow work, so a cancelled run
   * stops paying for it. It never aborts when the run was started without a `signal`.
   */
  signal: AbortSignal;
};

/**
 * A framework-neutral tool. Each adapter converts this to its own tool type (AI SDK `tool()`,
 * Mastra `createTool`, LangChain `tool`, TanStack `toolDefinition`). Standard Schema is the neutral schema
 * (zod, valibot, arktype, ...) and must be able to emit JSON Schema (a withJsonSchema wrapper works).
 *
 * Build one with `defineAgentTool` to get `input` typed from `inputSchema` and the `execute` return
 * typed from `output`.
 */
export type AgentTool<TInput = unknown, TOutput = unknown> = {
  name: string;
  description: string;
  /** Any Standard Schema. The model is shown its input JSON Schema; `execute` gets its parsed output. */
  inputSchema: StandardSchemaV1<unknown, TInput>;
  /**
   * Optional schema (Zod or any Standard Schema) for the tool's result. The runtime checks the
   * result against it before the model sees it; a mismatch fails the tool call with a
   * `ToolOutputError`, and the model gets that error instead of the bad value.
   */
  output?: StandardSchemaV1<TOutput, unknown>;
  /**
   * A method, not a function property, so a tool with a typed input still fits in an
   * `AgentTool[]`. That is safe because every runtime parses the model's input with
   * `inputSchema` before it calls `execute`, so `input` always has the declared type.
   * The return type comes from `output` when it is declared (`NoInfer` stops `execute` from
   * widening it).
   *
   * It may also return a failure from `@arki/failure` for an expected outcome ("city not
   * found"). The model then gets `{ error: { code, message, remediation, data } }` so it can
   * correct its next call, the output schema check is skipped, and the run emits
   * `tool:failure`. A thrown error stays a `tool:error`.
   */
  execute(
    input: TInput,
    options: AgentToolExecuteOptions,
  ): NoInfer<TOutput> | Failure | Promise<NoInfer<TOutput> | Failure>;
  /**
   * D-F-08 marker: required tools form the evidence floor. P0 records this but does NOT
   * enforce an eager floor — callers pre-run required tools and inject their results (as an
   * assessment agent can). Reserved for a future floor-enforcing option.
   */
  required?: boolean;
}

/** Input to a single agentic tool-loop run. */
export type ToolLoopInput = {
  system?: string;
  prompt: string;
  tools?: readonly AgentTool[];
  /** Hard cap on agent iterations (model + tool turns). */
  maxSteps?: number;
  /**
   * Cancels the run. Once it aborts, the run starts no new model call or tool call, the model
   * call in flight is aborted, every running tool sees the abort on its own `signal`, and the
   * event stream ends with a `run:error` whose failure is `Cancelled` (its cause is the signal's reason).
   */
  signal?: AbortSignal;
}

/** The swappable runtime backend. P0 ships `createAiSdkRuntime`; Mastra/LangGraph/TanStack follow. */
export type AgentRuntime = {
  runToolLoop(input: ToolLoopInput): AsyncIterable<RuntimeEvent>;
}
