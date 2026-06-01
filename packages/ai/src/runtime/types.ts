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

/**
 * A framework-neutral tool. Each adapter converts this to its own tool type (AI SDK `tool()`,
 * Mastra `createTool`, LangChain `tool`, TanStack `toolDefinition`). Zod is the neutral schema
 * because every target framework accepts it via Standard Schema.
 */
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput) => TOutput | Promise<TOutput>;
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
}

/** The swappable runtime backend. P0 ships `createAiSdkRuntime`; Mastra/LangGraph/TanStack follow. */
export interface AgentRuntime {
  runToolLoop(input: ToolLoopInput): AsyncIterable<RuntimeEvent>;
}
