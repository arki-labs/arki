import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { z } from 'zod';

import { defineFailure } from '@arki/failure';
import { withJsonSchema } from '@arki/schema';

import { ConfigurationError } from './errors';
import type { RuntimeEvent } from './runtime/types';
import { createMastraRuntime, toMastraTools } from './mastra';
import { defineAgentTool } from './runtime/tool';

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

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

describe('createMastraRuntime', () => {
  it('drives a Mastra Agent over an AI-SDK model and maps its stream to RuntimeEvents', async () => {
    // WHY: P1's contract is that Mastra is swappable behind the SAME AgentRuntime — it must
    // emit run:start, stream text, and finish, identically to the AI-SDK backend.
    const runtime = createMastraRuntime({ model: textOnlyModel() });
    const events = await collect(runtime.runToolLoop({ prompt: 'Assess Lumora.' }));

    expect(events[0]).toEqual({ type: 'run:start' });

    const streamedText = events
      .filter((e): e is Extract<RuntimeEvent, { type: 'text:delta' }> => e.type === 'text:delta')
      .map(e => e.delta)
      .join('');
    expect(streamedText).toContain('Lumora');

    expect(events.at(-1)?.type).toBe('run:finish');
  });
});

describe('toMastraTools', () => {
  it('converts neutral AgentTools into a keyed Mastra tool record preserving id + description', () => {
    const tools = toMastraTools([
      {
        name: 'analyze_distinctiveness',
        description: 'Competitor-relative distinctiveness.',
        inputSchema: z.object({ rationale: z.string() }),
        execute: () => ({ ok: true }),
      },
    ]);

    expect(Object.keys(tools)).toEqual(['analyze_distinctiveness']);
    expect(tools.analyze_distinctiveness?.id).toBe('analyze_distinctiveness');
    expect(tools.analyze_distinctiveness?.description).toBe('Competitor-relative distinctiveness.');
  });

  it('rejects at definition a tool whose schema cannot emit the draft-07 JSON Schema Mastra asks for', () => {
    // withJsonSchema answers only draft-2020-12; handing Mastra that dialect as draft-07 would
    // silently change what tuples and `items` mean, so the tool must fail loudly instead.
    const lookup = {
      name: 'lookup',
      description: 'Look something up.',
      inputSchema: withJsonSchema(v.object({ q: v.string() }), {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      }),
      execute: () => ({ ok: true }),
    };
    expect(() => toMastraTools([lookup])).toThrow(ConfigurationError);
    expect(() => toMastraTools([lookup])).toThrow(/tool "lookup".*draft-07/);
  });

  it('returns an empty record for a missing tool list', () => {
    expect(toMastraTools(undefined)).toEqual({});
  });
});

describe('createMastraRuntime cancellation', () => {
  it('ends at once with Cancelled, without any model call, when the signal is already aborted', async () => {
    // WHY: the Mastra backend honours the same AgentRuntime contract: a run cancelled before
    // it began must cost nothing.
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    const model = textOnlyModel();
    const runtime = createMastraRuntime({ model });

    const events = await collect(runtime.runToolLoop({ prompt: 'x', signal: controller.signal }));
    expect(events.map(event => event.type)).toEqual(['run:start', 'run:error']);
    expect(events[1]?.type === 'run:error' ? events[1].failure.code : undefined).toBe('ai.cancelled');
    expect(model.doStreamCalls).toHaveLength(0);
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

/** Step 1 calls `toolName`; every later step answers "done". */
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

const CityNotFound = defineFailure('city.not_found', {
  status: 404,
  data: z.object({ city: z.string() }),
  message: 'no city {city}',
  remediation: 'Use the English name of a real city, such as "Oslo".',
});

describe('createMastraRuntime tool failures', () => {
  it('sends the model the failure with its remediation, skips the output check and emits tool:failure', async () => {
    // WHY: both runtimes must behave the same, so a feature can swap backends without its
    // tools or its event consumers noticing.
    const weather = defineAgentTool({
      name: 'weather',
      description: 'Weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      output: z.object({ celsius: z.number() }),
      execute: ({ city }) => CityNotFound({ city }),
    });
    const model = toolCallingModel('weather');
    const events = await collect(createMastraRuntime({ model }).runToolLoop({ prompt: 'x', tools: [weather] }));

    expect(events).toContainEqual({
      type: 'tool:failure',
      tool: 'weather',
      failure: {
        code: 'city.not_found',
        message: 'no city Oslo',
        remediation: CityNotFound.remediation,
        data: { city: 'Oslo' },
      },
    });
    expect(events.some(event => event.type === 'tool:result' || event.type === 'tool:error')).toBe(false);
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain('city.not_found');
    expect(secondPrompt).toContain('Use the English name of a real city');
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
      createMastraRuntime({ model: toolCallingModel('weather') }).runToolLoop({ prompt: 'x', tools: [broken] }),
    );
    expect(events).toContainEqual({ type: 'tool:error', tool: 'weather', error: 'weather API down' });
    expect(events.some(event => event.type === 'tool:failure')).toBe(false);
  });
});

describe('createMastraRuntime terminal failures', () => {
  it('ends a run whose stream errors with one run:error carrying the typed failure, never run:finish', async () => {
    // WHY (F2): Mastra used to yield run:error for an error chunk and then run:finish, so a failed run
    // looked done and the failure was only message text.
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'hel' },
            {
              type: 'error',
              error: new APICallError({ message: 'status 401', url: 'https://x', requestBodyValues: {}, statusCode: 401 }),
            },
          ],
        }),
      }),
    });
    const runtime = createMastraRuntime({ model });
    const events = await collect(runtime.runToolLoop({ prompt: 'x' }));
    const terminal = events.filter(event => event.type === 'run:finish' || event.type === 'run:error');
    expect(terminal).toHaveLength(1);
    const last = events.at(-1);
    expect(last?.type).toBe('run:error');
    expect(last?.type === 'run:error' ? last.failure.code : undefined).toBe('ai.unauthorized');
  });
});
