import type { MastraModelConfig } from '@mastra/core/llm';
import type { MastraFinishReason } from '@mastra/core/stream';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';

import type { ProviderCall } from './ai-service/provider-failure.js';
import type { AgentRuntime, AgentTool, RuntimeEvent, RuntimeFailure, RuntimeUsage, ToolFailure, ToolLoopInput } from './runtime/types.js';
import { finishFailure, providerFailure } from './ai-service/provider-failure.js';
import { debugRuntime } from './debug.js';
import { Cancelled, ContentFiltered } from './failures.js';
import { requireJsonSchema } from './input-json-schema.js';
import { observeAiStream } from './observe.js';
import { runAgentTool } from './runtime/tool.js';

/**
 * Mastra-backed runtime (P1). Implements the SAME `AgentRuntime` contract as the AI-SDK
 * backend — the runtime choice is swappable. Adopted per founder decision "b" for Mastra's
 * platform depth (memory / evals / MCP), which stays Mastra-specific and is NOT abstracted
 * here (see docs/arki/research/ai/adapter-layer-proposal.md — over-abstraction is the #1 risk).
 *
 * `@mastra/core` is an OPTIONAL peer dependency: this module lives at the `@arki/ai/mastra`
 * subpath and is NOT re-exported from the main `@arki/ai` barrel, so consumers that don't use
 * the Mastra backend never need it installed.
 *
 * The model is a resolved AI-SDK `LanguageModel` (Mastra accepts AI-SDK models), so the same
 * LAW-1-resolved model can feed either backend.
 */
export type MastraRuntimeOptions = {
  /**
   * The model Mastra's Agent should use — either a resolved AI-SDK language model or a Mastra
   * model-router id (e.g. `'ollama/qwen3.6:latest'`). Typed as Mastra's own `MastraModelConfig`
   * because Mastra bundles its own AI-SDK provider types; `ai`'s `LanguageModel` union includes
   * a wider `string` arm that Mastra's router-id type rejects.
   */
  model: MastraModelConfig;
  name?: string;
  instructions?: string;
  defaultMaxSteps?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The failure a Mastra finish reason (the AI SDK's plus `unknown`, `tripwire` and `retry`) means, or undefined for `stop`. A `tripwire` (a processor
 * blocked the answer) is `ContentFiltered`; `unknown` and `retry` are an incomplete answer.
 */
function mastraFinishFailure(reason: MastraFinishReason, call: ProviderCall): RuntimeFailure | undefined {
  switch (reason) {
    case 'tripwire': {
      return ContentFiltered({ provider: call.provider, model: call.model });
    }
    case 'unknown':
    case 'retry': {
      return finishFailure('other', call);
    }
    default: {
      return finishFailure(reason, call);
    }
  }
}

/**
 * One neutral tool as a Mastra tool: gets the run's abort signal, its result is checked, and a
 * returned failure reaches `onFailure` with the tool call's id.
 * A named function per tool, not a closure in the loop: Hermes scopes loop `const`s to the
 * function, so a loop closure would see the last tool.
 */
function toMastraTool(
  agentTool: AgentTool,
  onFailure?: (toolCallId: string, failure: ToolFailure) => void,
): ReturnType<typeof createTool> {
  return createTool({
    id: agentTool.name,
    description: agentTool.description,
    // Mastra converts a tool's Standard Schema with target draft-07, so check that target now.
    inputSchema: requireJsonSchema(agentTool.inputSchema, `tool "${agentTool.name}"`, 'draft-07'),
    // Mastra 1.x createTool: execute is (inputData, context); inputData is the parsed schema.
    execute: async (inputData, context) =>
      runAgentTool(agentTool, inputData, context.abortSignal, failure => {
        // Mastra sets the call id when an agent runs the tool, which is the only way this runtime runs it.
        const toolCallId = context.agent?.toolCallId;
        if (toolCallId !== undefined) onFailure?.(toolCallId, failure);
      }),
  });
}

/** `onFailure` hears each tool call that returned a failure from `@arki/failure`. */
export function toMastraTools(
  tools: readonly AgentTool[] | undefined,
  onFailure?: (toolCallId: string, failure: ToolFailure) => void,
): Record<string, ReturnType<typeof createTool>> {
  const out: Record<string, ReturnType<typeof createTool>> = {};
  for (const agentTool of tools ?? []) out[agentTool.name] = toMastraTool(agentTool, onFailure);
  return out;
}

export function createMastraRuntime(options: MastraRuntimeOptions): AgentRuntime {
  const defaultMaxSteps = options.defaultMaxSteps ?? 8;

  async function* runLoop(input: ToolLoopInput): AsyncIterable<RuntimeEvent> {
    const { signal } = input;
    const maxSteps = input.maxSteps ?? defaultMaxSteps;
    debugRuntime.debug('mastra runToolLoop start (maxSteps={maxSteps}, tools={tools})', {
      maxSteps,
      tools: input.tools?.length ?? 0,
    });
    yield { type: 'run:start' };
    if (signal?.aborted) {
      yield { type: 'run:error', failure: Cancelled({ cause: signal.reason }) };
      return;
    }

    // Tool calls whose tool returned a failure, by call id: their result becomes `tool:failure`.
    const failures = new Map<string, ToolFailure>();
    // The names a failure carries, filled in from the resolved model once the agent exists.
    let call: ProviderCall = { provider: 'mastra', model: 'unknown', signal };
    try {
      const agentName = options.name ?? 'arki-runtime-agent';
      const agent = new Agent({
        id: agentName,
        name: agentName,
        instructions: input.system ?? options.instructions ?? 'You are a helpful assistant.',
        model: options.model,
        tools: toMastraTools(input.tools, (toolCallId, toolFailure) => failures.set(toolCallId, toolFailure)),
      });
      const model = await agent.getModel();
      call = { provider: model.provider, model: model.modelId, signal };

      const stream = await agent.stream(input.prompt, { maxSteps, abortSignal: signal });

      let text = '';
      let usage: RuntimeUsage | undefined;
      // The one terminal failure of the run, if any: the loop stops at the first one.
      let failure: RuntimeFailure | undefined;

      for await (const chunk of stream.fullStream) {
        if (signal?.aborted) {
          failure = Cancelled({ cause: signal.reason });
          break;
        }
        switch (chunk.type) {
          case 'text-delta': {
            text += chunk.payload.text;
            yield { type: 'text:delta', delta: chunk.payload.text };
            break;
          }
          case 'tool-call': {
            yield { type: 'tool:start', tool: chunk.payload.toolName, args: chunk.payload.args };
            break;
          }
          case 'tool-result': {
            const toolFailure = failures.get(chunk.payload.toolCallId);
            yield toolFailure === undefined
              ? { type: 'tool:result', tool: chunk.payload.toolName, result: chunk.payload.result }
              : { type: 'tool:failure', tool: chunk.payload.toolName, failure: toolFailure };
            break;
          }
          case 'tool-error': {
            yield {
              type: 'tool:error',
              tool: chunk.payload.toolName ?? '',
              error: errorMessage(chunk.payload.error),
            };
            break;
          }
          case 'finish': {
            const u = chunk.payload.output.usage;
            usage = {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              totalTokens: u.totalTokens,
            };
            // The last step's finish: `tool-calls` here means the step cap cut the run before an answer.
            failure = mastraFinishFailure(chunk.payload.stepResult.reason, call);
            break;
          }
          case 'error': {
            failure = providerFailure(chunk.payload.error, call);
            break;
          }
          case 'abort': {
            failure = Cancelled({ cause: signal?.reason });
            break;
          }
          default: {
            break;
          }
        }
        if (failure) break;
      }

      if (!failure && signal?.aborted) failure = Cancelled({ cause: signal.reason });
      if (failure) {
        debugRuntime.debug('mastra runToolLoop failed ({code})', { code: failure.code });
        yield { type: 'run:error', failure };
        return;
      }
      debugRuntime.debug('mastra runToolLoop finish (chars={chars}, totalTokens={totalTokens})', {
        chars: text.length,
        totalTokens: usage?.totalTokens,
      });
      yield { type: 'run:finish', text, usage };
    } catch (error) {
      const thrown = providerFailure(error, call);
      debugRuntime.debug('mastra runToolLoop failed ({code})', { code: thrown.code });
      yield { type: 'run:error', failure: thrown };
    }
  }

  return {
    runToolLoop(input: ToolLoopInput): AsyncIterable<RuntimeEvent> {
      return observeAiStream('ai.mastra.run_tool_loop', runLoop(input), event =>
        event.type === 'run:error' ? event.failure : undefined,
      );
    },
  };
}
