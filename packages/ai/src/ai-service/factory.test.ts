import { afterEach, expect, test, vi } from 'vitest';

import { z } from '@arki/contracts';

import { Cancelled } from '../failures';
import { createLLMProvider, DEFAULT_ANTHROPIC_MODEL, resolveLlmModel } from './factory';

afterEach(() => {
  vi.restoreAllMocks();
});
const schema = z.object({ summary: z.string() });

test('native Ollama uses /api/chat and constrained schema decoding', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(input instanceof Request ? input.url : input.toString()).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '');
    expect(body.format.properties.summary.type).toBe('string');
    expect(init?.signal).toBeDefined();
    return Response.json(
      {
        model: 'test',
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: '{"summary":"source"}' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 4,
        eval_count: 4,
      },
      { headers: { 'Content-Type': 'application/json' } },
    );
  });
  const provider = createLLMProvider({
    provider: 'ollama',
    model: 'test',
    baseURL: 'http://localhost:11434/v1',
    maxRetries: 0,
  });
  expect(await provider.generateStructuredData('input', schema, { signal: new AbortController().signal })).toEqual({
    summary: 'source',
  });
  expect(fetch).toHaveBeenCalledOnce();
});

test('explicit OpenAI-compatible endpoint uses chat completions and token limit', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(input instanceof Request ? input.url : input.toString()).toBe('https://compatible.test/v1/chat/completions');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.max_tokens).toBe(4000);
    return Response.json(
      {
        id: 'test',
        object: 'chat.completion',
        created: 1,
        model: 'test',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"summary":"source"}' } }],
        usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
      },
      { headers: { 'Content-Type': 'application/json' } },
    );
  });
  const provider = createLLMProvider({
    provider: 'openai',
    model: 'test',
    baseURL: 'https://compatible.test/v1',
    maxRetries: 0,
  });
  expect(await provider.generateStructuredData('input', schema, { maxTokens: 4000 })).toEqual({ summary: 'source' });
});

test('native Ollama passes caller cancellation to the HTTP transport', async () => {
  const controller = new AbortController();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
    init?.signal?.throwIfAborted();
    throw new Error('Expected cancellation');
  });
  const provider = createLLMProvider({
    provider: 'ollama',
    model: 'test',
    baseURL: 'http://localhost:11434/v1',
    maxRetries: 0,
  });
  const result = await provider.generateStructuredData('input', schema, { signal: controller.signal });
  expect(Cancelled.is(result)).toBe(true);
});

for (const mode of ['prompt', 'messages'] as const)
  test(`${mode} structured output applies schema transforms exactly once`, async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        {
          id: 'test',
          object: 'chat.completion',
          created: 1,
          model: 'test',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: '{"summary":"source","count":"4"}' },
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
        },
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const transformed = z.object({
      summary: z.string().transform(value => `${value}!`),
      count: z.string().transform(Number),
    });
    const provider = createLLMProvider({
      provider: 'openai',
      model: 'test',
      baseURL: 'https://compatible.test/v1',
      maxRetries: 0,
    });
    const output =
      mode === 'prompt'
        ? await provider.generateStructuredData('input', transformed)
        : await provider.generateStructuredDataFromMessages([{ role: 'user', content: 'input' }], transformed);
    expect(output).toEqual({ summary: 'source!', count: 4 });
  });

test('anthropic defaults to claude-sonnet-5-5 and LLM_MODEL-style override wins', () => {
  expect(resolveLlmModel({ provider: 'anthropic' })).toBe('claude-sonnet-5-5');
  expect(DEFAULT_ANTHROPIC_MODEL).toBe('claude-sonnet-5-5');
  expect(resolveLlmModel({ provider: 'anthropic', model: 'claude-opus-x' })).toBe('claude-opus-x');
});
