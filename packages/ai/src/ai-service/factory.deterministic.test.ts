/**
 * Deterministic mode — `createLLMProvider({ deterministicSeed })` (or `AI_DETERMINISTIC_SEED`).
 *
 * Why: tests run a real local model (the mock ladder's first rung). A model that answers the same
 * input differently from run to run makes a story test flaky for no product reason. With a seed,
 * every call runs at temperature 0 with that seed, so one input gets one answer — even when the
 * code under test asks for a creative temperature.
 *
 * Runs against the real Ollama daemon (`OLLAMA_BASE_URL`, default http://127.0.0.1:11434) and
 * model (`AI_TEST_MODEL`, default `gemma4:latest`). Without them the test fails with setup text.
 */
import { isFailure, orThrow } from '@arki/failure';
import { describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';

import { createLLMProvider } from './factory';
import { OllamaService } from './ollama-service';

const model = process.env['AI_TEST_MODEL'] ?? 'gemma4:latest';
const prompt = 'Write one short, unusual sentence about a lighthouse keeper.';

describe('deterministic mode on a real local model', () => {
  it('answers one input the same way twice, even when the call asks for temperature 1.5', { timeout: 180_000 }, async () => {
    const llm = createLLMProvider({ provider: 'ollama', model, deterministicSeed: 7 });

    const first = await llm.generateText(prompt, { temperature: 1.5, maxTokens: 600 });
    const second = await llm.generateText(prompt, { temperature: 1.5, maxTokens: 600 });

    if (isFailure(first)) throw new Error(`no answer from Ollama model ${model}: ${first.code}; is the daemon running?`);
    expect(first.trim().length, `no answer from Ollama model ${model}; is the daemon running?`).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  // Apps also build `OllamaService` directly (Avocabo's citation judge does): the seed must reach it too.
  it('makes OllamaService structured output repeatable too', { timeout: 180_000 }, async () => {
    const service = new OllamaService({ model, deterministicSeed: 7 });
    const schema = z.object({ sentence: z.string() });

    const first = orThrow(await service.generateStructuredData(prompt, schema, { temperature: 1.5 }));
    const second = await service.generateStructuredData(prompt, schema, { temperature: 1.5 });

    expect(first.sentence.trim().length, `no answer from Ollama model ${model}; is the daemon running?`).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });
});
