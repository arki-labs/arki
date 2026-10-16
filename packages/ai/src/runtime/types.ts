import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { z } from 'zod';

/**
 * Agent-runtime adapter layer — neutral contracts.
 *
 * The brandability bake-off (apps/brandability/backend/spikes/EVALUATION.md) proved the
 * agentic tool-loop is a commodity across AI SDK / Mastra / LangChain / LangGraph / TanStack.
 * These types are the framework-neutral seam every backend adapts to, so the runtime choice
 * is swappable rather than load-bearing. See packages/ai/docs/adapter-layer-proposal.md.
 *
 * Scope discipline (the #1 failure mode is over-abstraction): this layer adapts ONLY the tool
 * contract and the run→event stream. It does NOT wrap framework-specific depth (memory, eval
 * harnesses, graph builders, generative UI) — a feature that needs those depends on them
 * directly.
 */

/** Token accounting for one run (fields may be undefined when a provider omits usage). */
export interface RuntimeUsage {
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
  | { type: 'tool:error'; tool: string; error: string }
  | { type: 'run:finish'; text: string; usage?: RuntimeUsage }
  | { type: 'run:error'; error: string };

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
 * Mastra `createTool`, LangChain `tool`, TanStack `toolDefinition`). Zod is the neutral schema
 * because every target framework accepts it via Standard Schema.
 *
 * Build one with `defineAgentTool` to get `input` typed from `inputSchema` and the `execute` return
 * typed from `output`.
 */
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
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
   */
  execute(input: TInput, options: AgentToolExecuteOptions): NoInfer<TOutput> | Promise<NoInfer<TOutput>>;
  /**
   * D-F-08 marker: required tools form the evidence floor. P0 records this but does NOT
   * enforce an eager floor — callers pre-run required tools and inject their results (as the
   * brandability assessment-agent does). Reserved for a future floor-enforcing option.
   */
  required?: boolean;
}

/** Input to a single agentic tool-loop run. */
export interface ToolLoopInput {
  system?: string;
  prompt: string;
  tools?: ReadonlyArray<AgentTool>;
  /** Hard cap on agent iterations (model + tool turns). */
  maxSteps?: number;
  /**
   * Cancels the run. Once it aborts, the run starts no new model call or tool call, the model
   * call in flight is aborted, every running tool sees the abort on its own `signal`, and the
   * event stream rejects with the signal's reason.
   */
  signal?: AbortSignal;
}

/** The swappable runtime backend. P0 ships `createAiSdkRuntime`; Mastra/LangGraph/TanStack follow. */
export interface AgentRuntime {
  runToolLoop(input: ToolLoopInput): AsyncIterable<RuntimeEvent>;
}
