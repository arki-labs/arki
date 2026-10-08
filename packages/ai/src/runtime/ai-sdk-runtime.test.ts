import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAiSdkRuntime, toAiSdkToolSet } from './ai-sdk-runtime';
import type { RuntimeEvent } from './types';

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
