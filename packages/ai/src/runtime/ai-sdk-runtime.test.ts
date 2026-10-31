import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

import { Cancelled, ContentFiltered, IncompleteGeneration, RateLimited } from '../failures';

import type { AgentTool, RuntimeEvent } from './types';
import { createAiSdkRuntime, toAiSdkToolSet } from './ai-sdk-runtime';
import { defineAgentTool } from './tool';

/** Drains the async event stream into an array for assertions. */
async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** A mock model that streams two text chunks then finishes with usage. */
function textOnlyModel(): MockLanguageModelV4 {
  const chunks: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: 'Lumora ' },
    { type: 'text-delta', id: '1', delta: 'is solid.' },
    { type: 'text-end', id: '1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      // v6 model-level usage is structured; streamText derives the flat totalUsage from .total
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
    },
  ];
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
  });
}

describe('createAiSdkRuntime', () => {
  it('maps the AI-SDK stream onto the normalized RuntimeEvent contract', async () => {
    // WHY: the adapter's whole job is translation. If a future edit drops run:start, mangles
    // text, or loses usage, the downstream UI/event consumers silently break — this locks the
    // mapping in place.
    const runtime = createAiSdkRuntime({ model: textOnlyModel() });
    const events = await collect(runtime.runToolLoop({ prompt: 'Assess Lumora.' }));

    expect(events[0]).toEqual({ type: 'run:start' });

    const streamedText = events
      .filter((e): e is Extract<RuntimeEvent, { type: 'text:delta' }> => e.type === 'text:delta')
      .map(e => e.delta)
      .join('');
    expect(streamedText).toBe('Lumora is solid.');

    const last = events.at(-1);
    expect(last?.type).toBe('run:finish');
    if (last?.type === 'run:finish') {
      expect(last.text).toBe('Lumora is solid.');
      expect(last.usage?.totalTokens).toBe(15);
      expect(last.usage?.inputTokens).toBe(10);
    }
  });

  it('always emits run:start first, even before any model output', async () => {
    // WHY: UIs rely on run:start to switch into a "thinking" state immediately; it must not
    // depend on the model producing tokens.
    const runtime = createAiSdkRuntime({ model: textOnlyModel() });
    const events = await collect(runtime.runToolLoop({ prompt: 'x' }));
    expect(events[0]?.type).toBe('run:start');
  });
});

describe('toAiSdkToolSet', () => {
  it('converts neutral AgentTools into a keyed AI-SDK ToolSet preserving names + descriptions', () => {
    // WHY: the tool seam is the adapter's other half. Mis-keying or dropping the description
    // would make the model unable to select/justify tools — verify the conversion is faithful.
    const toolSet = toAiSdkToolSet([
      {
        name: 'analyze_distinctiveness',
        description: 'Competitor-relative distinctiveness.',
        inputSchema: z.object({ rationale: z.string() }),
        execute: () => ({ ok: true }),
      },
    ]);

    expect(toolSet && Object.keys(toolSet)).toEqual(['analyze_distinctiveness']);
    expect(toolSet?.analyze_distinctiveness?.description).toBe('Competitor-relative distinctiveness.');
  });

  it('returns undefined for an empty or missing tool list (no empty ToolSet sent to the model)', () => {
    expect(toAiSdkToolSet(undefined)).toBeUndefined();
    expect(toAiSdkToolSet([])).toBeUndefined();
  });
});

const finish = (unified: 'stop' | 'tool-calls'): LanguageModelV4StreamPart => ({
  type: 'finish',
  finishReason: { unified, raw: unified },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
});

/** Step 1 calls `toolName`; every later step answers "done". Counts the paid model calls. */
function toolCallingModel(toolName: string): MockLanguageModelV4 {
  const firstStep: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: 'call-1', toolName, input: '{"city":"Oslo"}' },
    finish('tool-calls'),
  ];
  const laterStep: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: 'done' },
    { type: 'text-end', id: '1' },
    finish('stop'),
  ];
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: () => {
      calls += 1;
      return Promise.resolve({ stream: simulateReadableStream({ chunks: calls === 1 ? firstStep : laterStep }) });
    },
  });
}

/** What the model was sent on its second call (the tool result goes back here). */
function secondPrompt(model: MockLanguageModelV4): string {
  return JSON.stringify(model.doStreamCalls[1]?.prompt);
}

describe('createAiSdkRuntime cancellation', () => {
  it('stops after an abort mid-tool: no second paid model call, and the run ends with Cancelled', async () => {
    // WHY: cancelling must stop spending. If the loop went on to the next step, a cancelled run
    // would still pay for another model call the user no longer wants.
    const controller = new AbortController();
    const reason = new Error('user cancelled');
    let toolSignal: AbortSignal | undefined;
    const weather = defineAgentTool({
      name: 'weather',
      description: 'Weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      execute(_input, { signal }) {
        toolSignal = signal;
        controller.abort(reason);
        return 'sunny';
      },
    });
    const model = toolCallingModel('weather');
    const runtime = createAiSdkRuntime({ model });

    const events = await collect(runtime.runToolLoop({ prompt: 'Weather?', tools: [weather], signal: controller.signal }));
    const last = events.at(-1);
    expect(last?.type === 'run:error' && Cancelled.is(last.failure)).toBe(true);
    expect(last?.type === 'run:error' ? last.failure.cause : undefined).toBe(reason);
    expect(events.filter(event => event.type === 'run:finish' || event.type === 'run:error')).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(toolSignal?.aborted).toBe(true);
  });

  it('ends at once with Cancelled, without any model call, when the signal is already aborted', async () => {
    // WHY: a request that was cancelled before the run began must cost nothing.
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    const model = textOnlyModel();
    const runtime = createAiSdkRuntime({ model });

    const events = await collect(runtime.runToolLoop({ prompt: 'x', signal: controller.signal }));
    expect(events.map(event => event.type)).toEqual(['run:start', 'run:error']);
    expect(events[1]?.type === 'run:error' ? events[1].failure.code : undefined).toBe('ai.cancelled');
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('passes the run signal to the model call', async () => {
    // WHY: aborting must cut the HTTP request in flight, not only stop the next step.
    const controller = new AbortController();
    const model = textOnlyModel();
    const runtime = createAiSdkRuntime({ model });
    await collect(runtime.runToolLoop({ prompt: 'x', signal: controller.signal }));
    controller.abort();
    expect(model.doStreamCalls[0]?.abortSignal?.aborted).toBe(true);
  });
});

describe('createAiSdkRuntime tool output schema', () => {
  it('fails the tool call with TOOL_OUTPUT_ERROR and never shows the bad value to the model', async () => {
    // WHY: the output schema is a promise to the model about what a tool returns. A tool that
    // breaks it must fail loudly, not feed the model a value it will misread.
    const weather: AgentTool = {
      name: 'weather',
      description: 'Weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      output: z.object({ celsius: z.number() }),
      execute: () => ({ celsius: 'leaked-bad-value' }),
    };
    const model = toolCallingModel('weather');
    const events = await collect(createAiSdkRuntime({ model }).runToolLoop({ prompt: 'x', tools: [weather] }));

    const toolError = events.find(event => event.type === 'tool:error');
    expect(toolError).toMatchObject({ type: 'tool:error', tool: 'weather' });
    expect(toolError?.type === 'tool:error' && toolError.error).toContain('does not match its output schema');
    expect(events.some(event => event.type === 'tool:result')).toBe(false);
    expect(secondPrompt(model)).not.toContain('leaked-bad-value');
  });

  it('sends the model the parsed result, so fields the schema drops never reach it', async () => {
    // WHY: the schema decides what the model sees. An extra field (here a secret) that the
    // schema does not declare must be stripped, not passed through.
    const weather = defineAgentTool({
      name: 'weather',
      description: 'Weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      output: z.object({ celsius: z.number() }),
      execute: () => ({ celsius: 21, apiKey: 'secret-key' }),
    });
    const model = toolCallingModel('weather');
    const events = await collect(createAiSdkRuntime({ model }).runToolLoop({ prompt: 'x', tools: [weather] }));

    expect(events).toContainEqual({ type: 'tool:result', tool: 'weather', result: { celsius: 21 } });
    expect(secondPrompt(model)).not.toContain('secret-key');
  });

  it('types execute from the schemas: input from inputSchema, return from output', () => {
    // WHY: types are written once, in the schemas. A tool whose execute drifts from its output
    // schema must fail to compile, not fail at run time.
    const weather = defineAgentTool({
      name: 'weather',
      description: 'Weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      output: z.object({ celsius: z.number() }),
      execute: input => {
        expectTypeOf(input).toEqualTypeOf<{ city: string }>();
        return { celsius: 1 };
      },
    });
    expectTypeOf(weather).toEqualTypeOf<AgentTool<{ city: string }, { celsius: number }>>();

    defineAgentTool({
      name: 'weather',
      description: 'Weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      output: z.object({ celsius: z.number() }),
      // @ts-expect-error -- the return does not match the output schema
      execute: () => ({ celsius: 'warm' }),
    });
  });
});

const CityNotFound = defineFailure('city.not_found', {
  status: 404,
  data: z.object({ city: z.string() }),
  message: 'no city {city}',
  remediation: 'Use the English name of a real city, such as "Oslo".',
});

describe('createAiSdkRuntime tool failures', () => {
  const weather = defineAgentTool({
    name: 'weather',
    description: 'Weather for a city.',
    inputSchema: z.object({ city: z.string() }),
    output: z.object({ celsius: z.number() }),
    execute: ({ city }) => CityNotFound({ city }),
  });

  it('sends the model the failure with its remediation, skips the output check and emits tool:failure', async () => {
    // WHY: the remediation sentence is how the model corrects its next call. If the failure
    // were checked against the output schema, or thrown, the model would only see "invalid output".
    const model = toolCallingModel('weather');
    const events = await collect(createAiSdkRuntime({ model }).runToolLoop({ prompt: 'x', tools: [weather] }));

    const failure = {
      code: 'city.not_found',
      message: 'no city Oslo',
      remediation: CityNotFound.remediation,
      data: { city: 'Oslo' },
    };
    expect(events).toContainEqual({ type: 'tool:failure', tool: 'weather', failure });
    expect(events.some(event => event.type === 'tool:result' || event.type === 'tool:error')).toBe(false);
    expect(secondPrompt(model)).toContain('city.not_found');
    expect(secondPrompt(model)).toContain('Use the English name of a real city');
    expect(events.at(-1)?.type).toBe('run:finish');
  });

  it('keeps a thrown error a tool:error', async () => {
    // WHY: a throw is a bug, not an expected outcome; it must not look like a failure value.
    const broken = defineAgentTool({
      name: 'weather',
      description: 'Weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      execute: () => {
        throw new Error('weather API down');
      },
    });
    const events = await collect(
      createAiSdkRuntime({ model: toolCallingModel('weather') }).runToolLoop({ prompt: 'x', tools: [broken] }),
    );
    expect(events).toContainEqual({ type: 'tool:error', tool: 'weather', error: 'weather API down' });
    expect(events.some(event => event.type === 'tool:failure')).toBe(false);
  });

  it('types execute to admit failures without widening the output type', () => {
    // WHY: returning a failure must compile, while a wrong success value must still fail to.
    expectTypeOf(weather).toEqualTypeOf<AgentTool<{ city: string }, { celsius: number }>>();
    defineAgentTool({
      name: 'weather',
      description: 'Weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      output: z.object({ celsius: z.number() }),
      execute: ({ city }) => (city === 'Oslo' ? { celsius: 3 } : CityNotFound({ city })),
    });
    defineAgentTool({
      name: 'weather',
      description: 'Weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      output: z.object({ celsius: z.number() }),
      // @ts-expect-error -- a failure is allowed, a wrong success value is not
      execute: ({ city }) => (city === 'Oslo' ? { celsius: 'cold' } : CityNotFound({ city })),
    });
  });
});

describe('createAiSdkRuntime spans', () => {
  const exporter = new InMemorySpanExporter();

  beforeAll(() => {
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  });

  afterEach(() => {
    exporter.reset();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    trace.disable();
  });

  const weather = defineAgentTool({
    name: 'weather',
    description: 'Weather for a city.',
    inputSchema: z.object({ city: z.string() }),
    execute: () => 'sunny',
  });

  it('records one span per model step and one per tool call when tracing is on', async () => {
    // WHY: a slow or failing agent run must show which step or tool cost the time.
    await collect(
      createAiSdkRuntime({ model: toolCallingModel('weather') }).runToolLoop({ prompt: 'x', tools: [weather] }),
    );

    const names = exporter.getFinishedSpans().map(span => span.name);
    expect(names.filter(name => name.startsWith('step '))).toHaveLength(2);
    expect(names.filter(name => name === 'execute_tool weather')).toHaveLength(1);
  });

  it('records nothing when AI_TELEMETRY=off', async () => {
    // WHY: an app must be able to keep prompts out of its traces while it still traces the rest.
    vi.stubEnv('AI_TELEMETRY', 'off');
    await collect(
      createAiSdkRuntime({ model: toolCallingModel('weather') }).runToolLoop({ prompt: 'x', tools: [weather] }),
    );

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

/** A model whose one step streams `parts` after the stream start. */
function streamingModel(parts: LanguageModelV4StreamPart[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] }, ...parts] }),
    }),
  });
}

function apiError(statusCode: number, responseHeaders?: Record<string, string>): APICallError {
  return new APICallError({ message: `status ${statusCode}`, url: 'https://x', requestBodyValues: {}, statusCode, responseHeaders });
}

describe('createAiSdkRuntime terminal failures', () => {
  it('ends a run whose stream errors with one run:error carrying RateLimited and its Retry-After, never run:finish', async () => {
    // WHY (F2): a 429 mid-stream used to yield run:error, keep reading, then run:finish, so the UI showed
    // a failed run as done and the Retry-After was lost in a message string.
    const runtime = createAiSdkRuntime({
      model: streamingModel([
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'hel' },
        { type: 'error', error: apiError(429, { 'retry-after': '2' }) },
      ]),
    });
    const events = await collect(runtime.runToolLoop({ prompt: 'x' }));
    expect(events.map(event => event.type)).toEqual(['run:start', 'text:delta', 'run:error']);
    const last = events.at(-1);
    expect(last?.type === 'run:error' ? last.failure.code : undefined).toBe('ai.rate_limited');
    expect(last?.type === 'run:error' && RateLimited.is(last.failure) ? last.failure.data.retryAfterMs : undefined).toBe(2000);
  });

  it('turns a content-filter finish into ContentFiltered, not a finished run', async () => {
    // WHY: a filtered answer is cut short; showing it as done would present a partial answer as whole.
    const runtime = createAiSdkRuntime({
      model: streamingModel([
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'par' },
        { type: 'text-end', id: '1' },
        {
          type: 'finish',
          finishReason: { unified: 'content-filter', raw: 'content_filter' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ]),
    });
    const events = await collect(runtime.runToolLoop({ prompt: 'x' }));
    const last = events.at(-1);
    expect(last?.type === 'run:error' && ContentFiltered.is(last.failure)).toBe(true);
    expect(events.some(event => event.type === 'run:finish')).toBe(false);
  });

  it('turns a run the step cap cut while the model still called tools into IncompleteGeneration', async () => {
    // WHY: with maxSteps reached mid tool use there is no answer yet; run:finish would claim one.
    const weather = defineAgentTool({
      name: 'weather',
      description: 'Weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      execute: () => 'sunny',
    });
    const runtime = createAiSdkRuntime({ model: toolCallingModel('weather') });
    const events = await collect(runtime.runToolLoop({ prompt: 'Weather?', tools: [weather], maxSteps: 1 }));
    const last = events.at(-1);
    expect(last?.type === 'run:error' && IncompleteGeneration.is(last.failure) ? last.failure.data.finishReason : undefined).toBe(
      'tool-calls',
    );
  });

  it('maps a model call that throws to the same failure as a streamed error', async () => {
    // WHY: one boundary maps provider errors (providerFailure), so a 401 is ProviderUnauthorized however it arrives.
    const runtime = createAiSdkRuntime({
      model: new MockLanguageModelV4({ doStream: () => Promise.reject(apiError(401)) }),
    });
    const events = await collect(runtime.runToolLoop({ prompt: 'x' }));
    expect(events.map(event => event.type)).toEqual(['run:start', 'run:error']);
    expect(events[1]?.type === 'run:error' ? events[1].failure.code : undefined).toBe('ai.unauthorized');
  });
});
