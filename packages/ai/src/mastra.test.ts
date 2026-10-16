import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMastraRuntime, toMastraTools } from './mastra';
import type { RuntimeEvent } from './runtime/types';

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

  it('returns an empty record for a missing tool list', () => {
    expect(toMastraTools(undefined)).toEqual({});
  });
});

describe('createMastraRuntime cancellation', () => {
  it('rejects at once, without any model call, when the signal is already aborted', async () => {
    // WHY: the Mastra backend honours the same AgentRuntime contract: a run cancelled before
    // it began must cost nothing.
    const controller = new AbortController();
    controller.abort(new Error('gone'));
    const model = textOnlyModel();
    const runtime = createMastraRuntime({ model });

    await expect(collect(runtime.runToolLoop({ prompt: 'x', signal: controller.signal }))).rejects.toThrow('gone');
    expect(model.doStreamCalls).toHaveLength(0);
  });
});
