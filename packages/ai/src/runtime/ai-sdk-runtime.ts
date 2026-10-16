import type { LanguageModel, ToolSet } from 'ai';
import { isStepCount, streamText, tool } from 'ai';

import type { AgentRuntime, AgentTool, RuntimeEvent, ToolFailure, ToolLoopInput } from './types';
import { aiTelemetry } from '../ai-service/telemetry';
import { debugRuntime } from '../debug';
import { abortReason, runAgentTool } from './tool';

/**
 * AI-SDK-backed runtime — the P0 default. Zero new dependencies: `@arki/ai` already wraps the
 * Vercel AI SDK (`@arki/ai/sdk` is `export * from 'ai'`). This is runtime "Arm A" from the
 * bake-off, lifted behind the neutral `AgentRuntime` contract.
 *
 * Cross-cutting `@arki/ai` concerns (LAW-1 provider precedence, cost, safety) compose around
 * this adapter; the caller supplies a resolved AI-SDK `LanguageModel`.
 *
 * Tracing uses the AI SDK's own telemetry (`aiTelemetry`, the same helper the AI services
 * use): when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, `@ai-sdk/otel` emits one `step N` span per
 * model step and one `execute_tool <name>` span per tool call. With no endpoint, or no
 * OpenTelemetry SDK registered, nothing is recorded.
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

/**
 * One neutral tool as an AI-SDK tool: gets the run's abort signal, its result is checked, and a
 * returned failure reaches `onFailure` with the tool call's id.
 */
function toAiSdkTool(agentTool: AgentTool, onFailure?: (toolCallId: string, failure: ToolFailure) => void) {
  return tool({
    description: agentTool.description,
    inputSchema: agentTool.inputSchema,
    execute: (input: unknown, { abortSignal, toolCallId }) =>
      runAgentTool(agentTool, input, abortSignal, failure => onFailure?.(toolCallId, failure)),
  });
}

/**
 * Convert neutral `AgentTool`s into an AI-SDK `ToolSet` (auto-executed inside the loop).
 * `onFailure` hears each tool call that returned a failure from `@arki/failure`.
 */
export function toAiSdkToolSet(
  tools: ReadonlyArray<AgentTool> | undefined,
  onFailure?: (toolCallId: string, failure: ToolFailure) => void,
): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  return Object.fromEntries(tools.map(agentTool => [agentTool.name, toAiSdkTool(agentTool, onFailure)] as const));
}

export function createAiSdkRuntime(options: AiSdkRuntimeOptions): AgentRuntime {
  const defaultMaxSteps = options.defaultMaxSteps ?? 8;

  return {
    async *runToolLoop(input: ToolLoopInput): AsyncIterable<RuntimeEvent> {
      const { signal } = input;
      if (signal?.aborted) throw abortReason(signal);
      const maxSteps = input.maxSteps ?? defaultMaxSteps;
      debugRuntime.debug('runToolLoop start (maxSteps={maxSteps}, tools={tools})', {
        maxSteps,
        tools: input.tools?.length ?? 0,
      });
      yield { type: 'run:start' };

      // Tool calls whose tool returned a failure, by call id: their result becomes `tool:failure`.
      const failures = new Map<string, ToolFailure>();
      try {
        const result = streamText({
          model: options.model,
          instructions: input.system,
          prompt: input.prompt,
          tools: toAiSdkToolSet(input.tools, (toolCallId, failure) => failures.set(toolCallId, failure)),
          abortSignal: signal,
          // The abort check stops the loop between steps, so no new model call starts.
          stopWhen: [isStepCount(maxSteps), () => signal?.aborted === true],
          ...aiTelemetry('arki.runtime.runToolLoop'),
        });

        for await (const part of result.stream) {
          if (signal?.aborted) throw abortReason(signal);
          switch (part.type) {
            case 'text-delta':
              yield { type: 'text:delta', delta: part.text };
              break;
            case 'tool-call':
              yield { type: 'tool:start', tool: part.toolName, args: part.input };
              break;
            case 'tool-result': {
              const failure = failures.get(part.toolCallId);
              yield failure === undefined
                ? { type: 'tool:result', tool: part.toolName, result: part.output }
                : { type: 'tool:failure', tool: part.toolName, failure };
              break;
            }
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

        if (signal?.aborted) throw abortReason(signal);
        const [text, usage] = await Promise.all([result.text, result.usage]);
        debugRuntime.debug('runToolLoop finish (chars={chars}, totalTokens={totalTokens})', {
          chars: text.length,
          totalTokens: usage.totalTokens,
        });
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
        if (signal?.aborted) throw abortReason(signal);
        debugRuntime.debug('runToolLoop error', { error: errorMessage(error) });
        yield { type: 'run:error', error: errorMessage(error) };
      }
    },
  };
}
