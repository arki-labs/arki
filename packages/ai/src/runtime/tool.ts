import type { StandardSchemaV1 } from '@standard-schema/spec';

import { isFailure } from '@arki/failure';

import type { AgentTool, ToolFailure } from './types';
import { ToolOutputError } from '../errors';

/**
 * Defines an `AgentTool` with its types inferred: `execute`'s `input` from `inputSchema`, and
 * its return from `output` when the tool declares one.
 *
 * ```ts
 * const weather = defineAgentTool({
 *   name: 'weather',
 *   description: 'Current temperature for a city.',
 *   inputSchema: z.object({ city: z.string() }),
 *   output: z.object({ celsius: z.number() }),
 *   async execute({ city }, { signal }) {
 *     const response = await fetch(`https://example.com/weather/${city}`, { signal });
 *     return { celsius: Number(await response.text()) };
 *   },
 * });
 * ```
 */
export function defineAgentTool<TInput, TOutput>(agentTool: AgentTool<TInput, TOutput>): AgentTool<TInput, TOutput> {
  return agentTool;
}

/**
 * The reason a signal aborted with. Old `AbortSignal` polyfills (some React Native builds) have
 * no `reason`, so this falls back to an `AbortError`.
 */
export function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return reason ?? Object.assign(new Error('This operation was aborted.'), { name: 'AbortError' });
}

/** Checks a tool's result against its output schema and returns the parsed value. */
async function checkToolOutput(
  toolName: string,
  schema: StandardSchemaV1<unknown, unknown>,
  value: unknown,
): Promise<unknown> {
  const checked = await schema['~standard'].validate(value);
  if (checked.issues !== undefined) throw new ToolOutputError(toolName, checked.issues);
  return checked.value;
}

/**
 * Runs one tool call the way every runtime adapter must: refuses to start once `signal` has
 * aborted, hands `signal` to the tool, and checks the result against the tool's `output`.
 * A returned failure skips that check: it reaches `onFailure`, and the model gets
 * `{ error: { code, message, remediation, data } }`.
 *
 * @internal Shared by the runtime adapters; not part of the public barrel.
 */
export async function runAgentTool(
  agentTool: AgentTool,
  input: unknown,
  signal: AbortSignal = new AbortController().signal,
  onFailure?: (failure: ToolFailure) => void,
): Promise<unknown> {
  if (signal.aborted) throw abortReason(signal);
  const result = await agentTool.execute(input, { signal });
  if (isFailure(result)) {
    const failure: ToolFailure = {
      code: result.code,
      message: result.message,
      remediation: result.remediation,
      data: result.data,
    };
    onFailure?.(failure);
    return { error: failure };
  }
  return agentTool.output === undefined ? result : checkToolOutput(agentTool.name, agentTool.output, result);
}
