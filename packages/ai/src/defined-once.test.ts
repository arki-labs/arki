import { describe, expect, expectTypeOf, it } from 'vitest';

import type { z } from '@arki/contracts';
import { orThrow } from '@arki/failure';
import { parse } from '@arki/schema';

import type { AnthropicServiceConfig } from './ai-service/anthropic-service';
import type { OpenAIServiceConfig } from './ai-service/openai-service';
import type { StructuredLLMProvider } from './ai-service/types';
import type { ClassifiedIntent, IntentType } from './capabilities/intent-classification';
import type { SanitizerConfig } from './safety/types';
import type { SemanticSearchService } from './semantic-search/search-service';
import type { RAGConfig, RAGServiceConfig, SearchMode, SearchSettings } from './types';
import type { AIServiceConfig, SearchOptions } from './validation';
import { classifyIntent } from './capabilities/intent-classification';
import { sanitizerConfigSchema } from './safety/types';
import { aiServiceConfigSchema, ragServiceConfigSchema, searchOptionsSchema, searchSettingsSchema } from './validation';

/** The provider's untyped JSON crosses the same schema boundary as a real model response. */
function providerFor(output: unknown): StructuredLLMProvider {
  return {
    generateStructuredData: (_prompt, schema) => Promise.resolve(orThrow(parse(schema, output))),
    generateStructuredDataFromMessages: () => {
      throw new Error('Unexpected conversation generation');
    },
    generateText: () => {
      throw new Error('Unexpected text generation');
    },
    streamConversation: () => {
      throw new Error('Unexpected streaming generation');
    },
  };
}

describe('schema-derived search and service configuration', () => {
  it('keeps query-less settings distinct from requests and gives the service the validated request shape', () => {
    expectTypeOf<SearchSettings>().toEqualTypeOf<z.output<typeof searchSettingsSchema>>();
    expectTypeOf<SearchSettings>().toEqualTypeOf<Omit<SearchOptions, 'query' | 'filters'>>();
    expectTypeOf<SearchMode>().toEqualTypeOf<NonNullable<SearchOptions['mode']>>();
    expectTypeOf<SearchOptions>().toEqualTypeOf<z.output<typeof searchOptionsSchema>>();
    expectTypeOf<Parameters<SemanticSearchService['search']>[0]>().toEqualTypeOf<SearchOptions>();

    const settings: SearchSettings = { mode: 'hybrid', limit: 20, scoreThreshold: 0.5 };
    expect(searchSettingsSchema.parse(settings)).toEqual(settings);
    expect(searchOptionsSchema.safeParse(settings).success).toBe(false);
    expect(searchOptionsSchema.safeParse({ ...settings, query: '' }).success).toBe(false);
    expect(searchOptionsSchema.parse({ ...settings, query: 'forests', filters: { kind: 'article' } })).toEqual({
      ...settings,
      query: 'forests',
      filters: { kind: 'article' },
    });
    expect(searchOptionsSchema.safeParse({ query: 'forests', mode: 'unrecognized' }).success).toBe(false);
  });

  it('separates RAG provider selection from provider-service constructor settings', () => {
    expectTypeOf<RAGServiceConfig>().toEqualTypeOf<z.output<typeof ragServiceConfigSchema>>();
    expectTypeOf<RAGConfig['aiService']>().toEqualTypeOf<RAGServiceConfig>();
    expectTypeOf<AIServiceConfig>().toEqualTypeOf<z.output<typeof aiServiceConfigSchema>>();
    expectTypeOf<OpenAIServiceConfig>().toEqualTypeOf<z.output<typeof aiServiceConfigSchema>>();
    expectTypeOf<SanitizerConfig>().toEqualTypeOf<z.output<typeof sanitizerConfigSchema>>();
    expectTypeOf<AnthropicServiceConfig>().toEqualTypeOf<
      Pick<AIServiceConfig, 'model' | 'temperature' | 'maxRetries'>
    >();
    expectTypeOf<NonNullable<OpenAIServiceConfig['sanitize']>>().toEqualTypeOf<boolean | SanitizerConfig>();

    expect(ragServiceConfigSchema.safeParse({ model: 'local-model' }).success).toBe(false);
    expect(
      ragServiceConfigSchema.parse({ provider: 'local', baseUrl: 'http://localhost:11434', maxTokens: 100 }),
    ).toEqual({
      provider: 'local',
      baseUrl: 'http://localhost:11434',
      maxTokens: 100,
    });
    expect(aiServiceConfigSchema.parse({ model: 'local-model', maxRetries: 0, sanitize: true })).toEqual({
      model: 'local-model',
      maxRetries: 0,
      sanitize: true,
    });
    expect(aiServiceConfigSchema.safeParse({ temperature: 3 }).success).toBe(false);
  });
});

it('validates programmatic sanitizer patterns without dropping or converting RegExp instances', () => {
  const injectionRule = /fleet-command/i;
  const piiRule = /fleet-secret/gi;
  const config: SanitizerConfig = {
    customInjectionPatterns: [{ pattern: injectionRule, description: 'Operator command' }],
    customPIIPatterns: [{ pattern: piiRule, replacement: '[REDACTED]', description: 'Operator secret' }],
  };
  const parsed = aiServiceConfigSchema.parse({ sanitize: config });
  expect(parsed.sanitize).toEqual(config);
  if (typeof parsed.sanitize !== 'object') throw new Error('Expected programmatic sanitizer configuration');
  expect(parsed.sanitize.customInjectionPatterns?.[0]?.pattern).toBe(injectionRule);
  expect(parsed.sanitize.customPIIPatterns?.[0]?.pattern).toBe(piiRule);
  expect(
    sanitizerConfigSchema.safeParse({
      customInjectionPatterns: [{ pattern: 'fleet-command', description: 'Invalid rule' }],
    }).success,
  ).toBe(false);
  expect(
    sanitizerConfigSchema.safeParse({ customPIIPatterns: [{ pattern: piiRule, description: 'Missing replacement' }] })
      .success,
  ).toBe(false);
});

describe('intent classification follows its provider output schema', () => {
  it('preserves retrieval decisions and optional hints in the inferred result', async () => {
    expectTypeOf<ClassifiedIntent['intent']>().toEqualTypeOf<IntentType>();
    expectTypeOf<Awaited<ReturnType<typeof classifyIntent>>>().toEqualTypeOf<ClassifiedIntent>();
    const output = { intent: 'search', requiresRAG: true, timeFilter: '7d', topicHint: 'forests' };
    expect(await classifyIntent('Find what I read about forests this week', providerFor(output))).toEqual(output);
    expect(await classifyIntent('What is a forest?', providerFor({ intent: 'general', requiresRAG: false }))).toEqual({
      intent: 'general',
      requiresRAG: false,
    });
  });

  it('rejects unknown intent categories and missing retrieval decisions from a model', async () => {
    await expect(
      classifyIntent('Find forests', providerFor({ intent: 'unsupported', requiresRAG: true })),
    ).rejects.toThrow();
    await expect(classifyIntent('Find forests', providerFor({ intent: 'search' }))).rejects.toThrow();
  });
});
