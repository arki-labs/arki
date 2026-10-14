import type { MastraModelConfig } from '@mastra/core/llm';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';

import type { AgentRuntime, AgentTool, RuntimeEvent, RuntimeUsage, ToolLoopInput } from './runtime/types';
import { debugRuntime } from './debug';

/**
 * Mastra-backed runtime (P1). Implements the SAME `AgentRuntime` contract as the AI-SDK
 * backend — the runtime choice is swappable. Adopted per founder decision "b" for Mastra's
 * platform depth (memory / evals / MCP), which stays Mastra-specific and is NOT abstracted
 * here (see packages/ai/docs/adapter-layer-proposal.md — over-abstraction is the #1 risk).
 *
 * `@mastra/core` is an OPTIONAL peer dependency: this module lives at the `@arki/ai/mastra`
 * subpath and is NOT re-exported from the main `@arki/ai` barrel, so consumers that don't use
 * the Mastra backend never need it installed.
 *
 * The model is a resolved AI-SDK `LanguageModel` (Mastra accepts AI-SDK models), so the same
 * LAW-1-resolved model can feed either backend.
 */
export interface MastraRuntimeOptions {
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

export function toMastraTools(
  tools: ReadonlyArray<AgentTool> | undefined,
): Record<string, ReturnType<typeof createTool>> {
  const out: Record<string, ReturnType<typeof createTool>> = {};
  for (const agentTool of tools ?? []) {
    out[agentTool.name] = createTool({
      id: agentTool.name,
      description: agentTool.description,
      inputSchema: agentTool.inputSchema,
      // Mastra 1.x createTool: execute is (inputData, context); inputData is the parsed schema.
      execute: async inputData => agentTool.execute(inputData),
    });
  }
  return out;
}

export function createMastraRuntime(options: MastraRuntimeOptions): AgentRuntime {
  const defaultMaxSteps = options.defaultMaxSteps ?? 8;

  return {
    async *runToolLoop(input: ToolLoopInput): AsyncIterable<RuntimeEvent> {
      const maxSteps = input.maxSteps ?? defaultMaxSteps;
      debugRuntime.debug('mastra runToolLoop start (maxSteps={maxSteps}, tools={tools})', {
        maxSteps,
        tools: input.tools?.length ?? 0,
      });
      yield { type: 'run:start' };

      try {
        const agentName = options.name ?? 'arki-runtime-agent';
        const agent = new Agent({
          id: agentName,
          name: agentName,
          instructions: input.system ?? options.instructions ?? 'You are a helpful assistant.',
          model: options.model,
          tools: toMastraTools(input.tools),
        });

        const stream = await agent.stream(input.prompt, { maxSteps });

        let text = '';
        let usage: RuntimeUsage | undefined;

        for await (const chunk of stream.fullStream) {
          switch (chunk.type) {
            case 'text-delta':
              text += chunk.payload.text;
              yield { type: 'text:delta', delta: chunk.payload.text };
              break;
            case 'tool-call':
              yield { type: 'tool:start', tool: chunk.payload.toolName, args: chunk.payload.args };
              break;
            case 'tool-result':
              yield { type: 'tool:result', tool: chunk.payload.toolName, result: chunk.payload.result };
              break;
            case 'tool-error':
              yield {
                type: 'tool:error',
                tool: chunk.payload.toolName ?? '',
                error: errorMessage(chunk.payload.error),
              };
              break;
            case 'finish': {
              const u = chunk.payload.output.usage;
              usage = {
                inputTokens: u.inputTokens,
                outputTokens: u.outputTokens,
                totalTokens: u.totalTokens,
              };
              break;
            }
            case 'error':
              yield { type: 'run:error', error: errorMessage(chunk.payload.error) };
              break;
            default:
              break;
          }
        }

        debugRuntime.debug('mastra runToolLoop finish (chars={chars}, totalTokens={totalTokens})', {
          chars: text.length,
          totalTokens: usage?.totalTokens,
        });
        yield { type: 'run:finish', text, usage };
      } catch (error) {
        debugRuntime.debug('mastra runToolLoop error', { error: errorMessage(error) });
        yield { type: 'run:error', error: errorMessage(error) };
      }
    },
  };
}
