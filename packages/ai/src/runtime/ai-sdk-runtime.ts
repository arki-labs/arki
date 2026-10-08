import { isStepCount, streamText, tool, type LanguageModel, type ToolSet } from 'ai';

import { debugRuntime } from '../debug';
import type { AgentRuntime, AgentTool, RuntimeEvent, ToolLoopInput } from './types';

/**
 * AI-SDK-backed runtime — the P0 default. Zero new dependencies: `@arki/ai` already wraps the
 * Vercel AI SDK (`@arki/ai/sdk` is `export * from 'ai'`). This is runtime "Arm A" from the
 * bake-off, lifted behind the neutral `AgentRuntime` contract.
 *
 * Cross-cutting `@arki/ai` concerns (LAW-1 provider precedence, cost, safety) compose around
 * this adapter; the caller supplies a resolved AI-SDK `LanguageModel`.
 */
export interface AiSdkRuntimeOptions {
  /** A resolved AI-SDK language model (e.g. `ollama('qwen3.6')` under LAW-1). */
  model: LanguageModel;
  /** Default agent-iteration cap when a run does not specify `maxSteps`. */
  defaultMaxSteps?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Convert neutral `AgentTool`s into an AI-SDK `ToolSet` (auto-executed inside the loop). */
export function toAiSdkToolSet(tools: ReadonlyArray<AgentTool> | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  const entries = tools.map(
    agentTool =>
      [
        agentTool.name,
        tool({
          description: agentTool.description,
          inputSchema: agentTool.inputSchema,
          execute: (input: unknown) => agentTool.execute(input),
        }),
      ] as const,
  );
  return Object.fromEntries(entries);
}

export function createAiSdkRuntime(options: AiSdkRuntimeOptions): AgentRuntime {
  const defaultMaxSteps = options.defaultMaxSteps ?? 8;

  return {
    async *runToolLoop(input: ToolLoopInput): AsyncIterable<RuntimeEvent> {
      const maxSteps = input.maxSteps ?? defaultMaxSteps;
      debugRuntime('runToolLoop start (maxSteps=%d, tools=%d)', maxSteps, input.tools?.length ?? 0);
      yield { type: 'run:start' };

      try {
        const result = streamText({
          model: options.model,
          instructions: input.system,
          prompt: input.prompt,
          tools: toAiSdkToolSet(input.tools),
          stopWhen: isStepCount(maxSteps),
        });

        for await (const part of result.stream) {
          switch (part.type) {
            case 'text-delta':
              yield { type: 'text:delta', delta: part.text };
              break;
            case 'tool-call':
              yield { type: 'tool:start', tool: part.toolName, args: part.input };
              break;
            case 'tool-result':
              yield { type: 'tool:result', tool: part.toolName, result: part.output };
              break;
            case 'tool-error':
              yield { type: 'tool:error', tool: part.toolName, error: errorMessage(part.error) };
              break;
            case 'error':
              yield { type: 'run:error', error: errorMessage(part.error) };
              break;
            default:
              break;
          }
        }

        const [text, usage] = await Promise.all([result.text, result.usage]);
        debugRuntime('runToolLoop finish (chars=%d, totalTokens=%o)', text.length, usage.totalTokens);
        yield {
          type: 'run:finish',
          text,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          },
        };
      } catch (error) {
        debugRuntime('runToolLoop error: %s', errorMessage(error));
        yield { type: 'run:error', error: errorMessage(error) };
      }
    },
  };
}
