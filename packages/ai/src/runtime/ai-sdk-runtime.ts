import type { LanguageModel, ToolSet } from 'ai';
import { isStepCount, streamText, tool } from 'ai';

import type { AgentRuntime, AgentTool, RuntimeEvent, RuntimeFailure, ToolFailure, ToolLoopInput } from './types';
import { modelSchema } from '../ai-service/model-schema';
import { finishFailure, providerFailure } from '../ai-service/provider-failure';
import { aiTelemetry } from '../ai-service/telemetry';
import { debugRuntime } from '../debug';
import { Cancelled } from '../failures';
import { runAgentTool } from './tool';

/**
 * AI-SDK-backed runtime — the P0 default. Zero new dependencies: `@arki/ai` already wraps the
 * Vercel AI SDK (`@arki/ai/sdk` is `export * from 'ai'`). This is runtime "Arm A" from the
 * bake-off, lifted behind the neutral `AgentRuntime` contract.
 *
 * Cross-cutting `@arki/ai` concerns (LAW-1 provider precedence, cost, safety) compose around
 * this adapter; the caller supplies a resolved AI-SDK `LanguageModel`.
 *
 * Tracing uses the AI SDK's own telemetry (`aiTelemetry`, the same helper the AI services
 * use): when an OpenTelemetry tracer provider is registered, `@ai-sdk/otel` emits one `step N`
 * span per model step and one `execute_tool <name>` span per tool call. With no tracer provider,
 * or with `AI_TELEMETRY=off`, nothing is recorded.
 */
export type AiSdkRuntimeOptions = {
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
    inputSchema: modelSchema(agentTool.inputSchema, `tool "${agentTool.name}"`),
    execute: (input: unknown, { abortSignal, toolCallId }) =>
      runAgentTool(agentTool, input, abortSignal, failure => onFailure?.(toolCallId, failure)),
  });
}

/**
 * Convert neutral `AgentTool`s into an AI-SDK `ToolSet` (auto-executed inside the loop).
 * `onFailure` hears each tool call that returned a failure from `@arki/failure`.
 */
export function toAiSdkToolSet(
  tools: readonly AgentTool[] | undefined,
  onFailure?: (toolCallId: string, failure: ToolFailure) => void,
): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;
  return Object.fromEntries(tools.map(agentTool => [agentTool.name, toAiSdkTool(agentTool, onFailure)] as const));
}

/** The provider and model names a failure of this runtime carries. */
function modelNames(model: LanguageModel): { provider: string; model: string } {
  return typeof model === 'string' ? { provider: 'gateway', model } : { provider: model.provider, model: model.modelId };
}

export function createAiSdkRuntime(options: AiSdkRuntimeOptions): AgentRuntime {
  const defaultMaxSteps = options.defaultMaxSteps ?? 8;
  const names = modelNames(options.model);

  return {
    async *runToolLoop(input: ToolLoopInput): AsyncIterable<RuntimeEvent> {
      const { signal } = input;
      const call = { ...names, signal };
      const maxSteps = input.maxSteps ?? defaultMaxSteps;
      debugRuntime.debug('runToolLoop start (maxSteps={maxSteps}, tools={tools})', {
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
      // The one terminal failure of the run, if any: the loop stops at the first one.
      let failure: RuntimeFailure | undefined;
      try {
        const result = streamText({
          model: options.model,
          instructions: input.system,
          prompt: input.prompt,
          tools: toAiSdkToolSet(input.tools, (toolCallId, toolFailure) => failures.set(toolCallId, toolFailure)),
          abortSignal: signal,
          // The abort check stops the loop between steps, so no new model call starts.
          stopWhen: [isStepCount(maxSteps), () => signal?.aborted === true],
          ...aiTelemetry('arki.runtime.runToolLoop'),
        });

        for await (const part of result.stream) {
          if (signal?.aborted) {
            failure = Cancelled({ cause: signal.reason });
            break;
          }
          switch (part.type) {
            case 'text-delta': {
              yield { type: 'text:delta', delta: part.text };
              break;
            }
            case 'tool-call': {
              yield { type: 'tool:start', tool: part.toolName, args: part.input };
              break;
            }
            case 'tool-result': {
              const toolFailure = failures.get(part.toolCallId);
              yield toolFailure === undefined
                ? { type: 'tool:result', tool: part.toolName, result: part.output }
                : { type: 'tool:failure', tool: part.toolName, failure: toolFailure };
              break;
            }
            case 'tool-error': {
              yield { type: 'tool:error', tool: part.toolName, error: errorMessage(part.error) };
              break;
            }
            case 'error': {
              failure = providerFailure(part.error, call);
              break;
            }
            case 'abort': {
              failure = Cancelled({ cause: signal?.reason });
              break;
            }
            case 'finish': {
              // The last step's finish: `tool-calls` here means the step cap cut the run before an answer.
              failure = finishFailure(part.finishReason, call);
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
          debugRuntime.debug('runToolLoop failed ({code})', { code: failure.code });
          yield { type: 'run:error', failure };
          return;
        }
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
        const thrown = providerFailure(error, call);
        debugRuntime.debug('runToolLoop failed ({code})', { code: thrown.code });
        yield { type: 'run:error', failure: thrown };
      }
    },
  };
}
