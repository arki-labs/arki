/**
 * `@arki/ai/testing`: apps test AI steps without HTTP or a model, and the fake runs the same
 * adapter as `createLLMProvider`, so what passes against the fake holds for a real provider.
 */
import { describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';

import { GenerationError } from '../errors';
import { createFakeLLMProvider } from './index';

const planet = z.object({ planet: z.string() });

describe('createFakeLLMProvider', () => {
  it('returns the scripted answers in order, parsed by the schema, with usage (lib-gaps 22, 27)', async () => {
    // WHY: a test must control what the model says and must be able to assert the cost of a call;
    // usage next to the value is what lets an app log or price the call without telemetry hooks.
    const llm = createFakeLLMProvider({
      answers: [{ planet: 'Mars' }, { planet: 'Venus' }],
      usage: { inputTokens: 7, outputTokens: 3 },
    });

    const first = await llm.generateStructuredResult('Name one planet.', planet, { systemPrompt: 'Be brief.' });
    const second = await llm.generateStructuredData('Another.', planet);

    expect(first).toEqual({
      value: { planet: 'Mars' },
      usage: { inputTokens: 7, outputTokens: 3 },
      provider: 'fake',
      model: 'fake-model',
    });
    expect(second).toEqual({ planet: 'Venus' });
    expect(llm.calls.map(call => [call.system, call.prompt])).toEqual([
      ['Be brief.', 'Name one planet.'],
      [undefined, 'Another.'],
    ]);
    expect(llm.calls[0]?.jsonSchema).toMatchObject({ properties: { planet: { type: 'string' } } });
  });

  it('rejects an answer the schema does not accept, as a real model answer would be', async () => {
    // WHY: the app's "model answered in the wrong shape" path must be testable; a fake that
    // skipped the schema check would let half-valid output reach the database in tests only.
    const llm = createFakeLLMProvider({ answers: [{ planet: 42 }] });

    await expect(llm.generateStructuredData('Name one planet.', planet)).rejects.toBeInstanceOf(GenerationError);
  });

  it('picks the answer from the call when given a function', async () => {
    // WHY: an e2e run makes calls in an order the test does not fix; the answer must depend on
    // what was asked (the schema's fields, a marker in the prompt), not on call order.
    const llm = createFakeLLMProvider({
      answers: call => (call.jsonSchema === undefined ? `echo: ${call.prompt}` : { planet: 'Mars' }),
    });

    await expect(llm.generateText('hi')).resolves.toBe('echo: hi');
    await expect(llm.generateStructuredData('x', planet)).resolves.toEqual({ planet: 'Mars' });
    await expect(llm.generateTextResult('usage')).resolves.toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('throws when a call has no scripted answer left', async () => {
    // WHY: an unexpected extra model call is a bug in the code under test; answering it with a
    // default would hide it.
    const llm = createFakeLLMProvider({ answers: ['only one'] });
    await llm.generateText('first');

    await expect(llm.generateText('second')).rejects.toThrow(/call 2 has no scripted answer/u);
  });

  it('streams a conversation from the script', async () => {
    // WHY: chat routes stream; they must be testable with the same fake.
    const llm = createFakeLLMProvider({ answers: ['Hello there'] });
    let text = '';
    for await (const chunk of llm.streamConversation([{ role: 'user', content: 'Hi' }])) text += chunk;

    expect(text).toBe('Hello there');
    expect(llm.calls[0]?.prompt).toBe('Hi');
  });
});
