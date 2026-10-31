/**
 * `@arki/ai/testing`: a deterministic fake model provider for tests. No HTTP, no model.
 *
 * The fake answers at the AI SDK model boundary, so everything above it runs for real: the
 * schema check of `generateStructuredData`, usage reporting, telemetry spans. Its answers are
 * scripted, never generated: a test that needs the model to reason passes or fails for the
 * wrong reason with this fake.
 */
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import type { LLMProviderWithUsage } from '../ai-service/types.js';
import { adaptLanguageModel } from '../ai-service/factory.js';

/** What the fake model was asked, in the order it was asked. */
export type FakeCall = {
  /** The system prompt, or `undefined` when the call had none. */
  readonly system: string | undefined;
  /** The text of every user and assistant message, joined by newlines. */
  readonly prompt: string;
  /** The JSON Schema a structured call showed the model, or `undefined` for a text call. */
  readonly jsonSchema: unknown;
};

/** A scripted answer: a string is sent as is, anything else as its JSON text. */
export type FakeAnswer = string | Readonly<Record<string, unknown>> | readonly unknown[];

export type FakeLLMProviderOptions = {
  /**
   * The answers, in call order, or a function that picks the answer from the call. A call after
   * the last scripted answer returns `UnexpectedDefect`, so a test never reads an answer it did not write.
   */
  readonly answers: readonly FakeAnswer[] | ((call: FakeCall) => FakeAnswer);
  /** The usage every call reports. Default `{ inputTokens: 10, outputTokens: 5 }`. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  /** The provider name results and spans carry. Default `fake`. */
  readonly provider?: string;
  /** The model id results and spans carry. Default `fake-model`. */
  readonly model?: string;
};

/** The fake: a full `LLMProviderWithUsage`, plus every call it received. */
export type FakeLLMProvider = LLMProviderWithUsage & { readonly calls: readonly FakeCall[] };

type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];

/** The parts of the AI SDK prompt a test asserts on. */
function callOf(options: CallOptions): FakeCall {
  const system = options.prompt.find(message => message.role === 'system');
  const prompt = options.prompt
    .flatMap(message =>
      message.role === 'user' || message.role === 'assistant'
        ? message.content.flatMap(part => (part.type === 'text' ? [part.text] : []))
        : [],
    )
    .join('\n');
  const format = options.responseFormat;
  return {
    system: system?.content,
    prompt,
    jsonSchema: format?.type === 'json' ? format.schema : undefined,
  };
}

/**
 * A provider that answers from a script and reports fixed usage. `generateStructuredData` still
 * parses the answer with your schema, so an answer that does not fit returns `InvalidOutput`
 * exactly as a real model's would.
 *
 * @example
 * ```ts
 * const llm = createFakeLLMProvider({ answers: [{ planet: 'Mars' }] });
 * const answer = await llm.generateStructuredResult('Name one planet.', z.object({ planet: z.string() }));
 * answer.value; // { planet: 'Mars' }
 * answer.usage; // { inputTokens: 10, outputTokens: 5 }
 * llm.calls[0]?.prompt; // 'Name one planet.'
 * ```
 */
export function createFakeLLMProvider(options: FakeLLMProviderOptions): FakeLLMProvider {
  const calls: FakeCall[] = [];
  const { inputTokens, outputTokens } = options.usage ?? { inputTokens: 10, outputTokens: 5 };
  const provider = options.provider ?? 'fake';
  const model = options.model ?? 'fake-model';
  const usage = {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
  };
  const finishReason = { unified: 'stop', raw: 'stop' } as const;

  const answer = (callOptions: CallOptions): string => {
    const call = callOf(callOptions);
    calls.push(call);
    const { answers } = options;
    let scripted: FakeAnswer | undefined;
    if (typeof answers === 'function') scripted = answers(call);
    else {
      scripted = answers[calls.length - 1];
      if (scripted === undefined) {
        throw new Error(`createFakeLLMProvider: call ${calls.length} has no scripted answer (${answers.length} given)`);
      }
    }
    return typeof scripted === 'string' ? scripted : JSON.stringify(scripted);
  };

  const languageModel = new MockLanguageModelV4({
    provider,
    modelId: model,
    doGenerate: callOptions =>
      Promise.resolve({ content: [{ type: 'text', text: answer(callOptions) }], finishReason, usage, warnings: [] }),
    doStream: callOptions =>
      Promise.resolve({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'fake' },
            { type: 'text-delta', id: 'fake', delta: answer(callOptions) },
            { type: 'text-end', id: 'fake' },
            { type: 'finish', finishReason, usage },
          ],
        }),
      }),
  });

  const adapted = adaptLanguageModel(languageModel, {
    provider,
    model,
    temperature: 0,
    maxRetries: 0,
    deterministicSeed: undefined,
  });
  return Object.assign(adapted, { calls });
}
