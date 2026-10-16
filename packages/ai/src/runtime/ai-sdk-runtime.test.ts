import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import { createAiSdkRuntime, toAiSdkToolSet } from './ai-sdk-runtime';
import { defineAgentTool } from './tool';
import type { AgentTool, RuntimeEvent } from './types';

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
  it('stops after an abort mid-tool: no second paid model call, and the run rejects with the reason', async () => {
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

    await expect(
      collect(runtime.runToolLoop({ prompt: 'Weather?', tools: [weather], signal: controller.signal })),
    ).rejects.toBe(reason);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(toolSignal?.aborted).toBe(true);
  });

  it('rejects at once, without any model call, when the signal is already aborted', async () => {
    // WHY: a request that was cancelled before the run began must cost nothing.
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    const model = textOnlyModel();
    const runtime = createAiSdkRuntime({ model });

    await expect(collect(runtime.runToolLoop({ prompt: 'x', signal: controller.signal }))).rejects.toThrow('gone');
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
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
    await collect(
      createAiSdkRuntime({ model: toolCallingModel('weather') }).runToolLoop({ prompt: 'x', tools: [weather] }),
    );

    const names = exporter.getFinishedSpans().map(span => span.name);
    expect(names.filter(name => name.startsWith('step '))).toHaveLength(2);
    expect(names.filter(name => name === 'execute_tool weather')).toHaveLength(1);
  });

  it('records nothing when no OTel backend is configured', async () => {
    // WHY: apps without tracing must not pay for it or leak prompts into it.
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    await collect(
      createAiSdkRuntime({ model: toolCallingModel('weather') }).runToolLoop({ prompt: 'x', tools: [weather] }),
    );

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
