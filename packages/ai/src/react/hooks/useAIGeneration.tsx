'use client';

/**
 * React hook for AI content generation
 */

import { useCallback, useState } from 'react';
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';
import { parse } from '@arki/schema';

import type { RuntimeFailure } from '../../runtime/types';
import { inputJsonSchema } from '../../input-json-schema';
import { jsonTextSchema, readFailureResponse } from '../../runtime/sse';
import { connectionFailure } from '../../runtime/types';

/** The kinds of generation a request asks for; one list feeds the types and the response schema. */
const GENERATION_TYPES = ['text', 'structured', 'stream'] as const;

export type GenerationOptions = {
  type?: (typeof GENERATION_TYPES)[number];
  /** Any Standard Schema for structured generation. The request carries its input JSON Schema as `jsonSchema`. */
  schema?: StandardSchemaV1;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export type GenerationResult = {
  content: string | Record<string, unknown>;
  type: (typeof GENERATION_TYPES)[number];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  metadata?: Record<string, string | number | boolean>;
}

/** A {@link GenerationResult}, the body of a non-stream response. A two-way type test locks it to the type. */
export const generationResultSchema = z.object({
  content: z.union([z.string(), z.record(z.string(), z.unknown())]),
  type: z.enum(GENERATION_TYPES),
  usage: z
    .object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const generationResponseSchema = jsonTextSchema.pipe(generationResultSchema);

export type UseAIGenerationOptions = {
  apiEndpoint?: string;
  defaultOptions?: GenerationOptions;
  onSuccess?: (result: GenerationResult) => void;
  /**
   * Hears why a generation failed: the failure the server answered with (its `{ error: envelope }`
   * body, revived), `InvalidInput` for a body that is not a `GenerationResult`, `ConnectionLost` or
   * `Cancelled` when the connection broke.
   */
  onError?: (failure: RuntimeFailure) => void;
}

export type UseAIGenerationReturn = {
  /** Resolves to the result, or to the failure (also set as `error`). It does not throw for a failed request. */
  generate: (prompt: string, options?: GenerationOptions) => Promise<GenerationResult | RuntimeFailure>;
  isGenerating: boolean;
  result: GenerationResult | null;
  error: RuntimeFailure | null;
  clear: () => void;
}

/** Reads a plain-text stream body, reporting the text so far after every chunk. */
async function readTextStream(
  body: ReadableStream<Uint8Array>,
  onPartial: (result: GenerationResult) => void,
): Promise<GenerationResult | RuntimeFailure> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` keeps a character split across two chunks whole.
      content += decoder.decode(value, { stream: true });
      onPartial({ content, type: 'stream' });
    }
    content += decoder.decode();
  } catch (error) {
    return connectionFailure(error);
  } finally {
    reader.releaseLock();
  }
  return { content, type: 'stream' };
}

/** One generation request: the result, or the failure the server, the body or the connection gave. */
async function requestGeneration(
  apiEndpoint: string,
  prompt: string,
  options: GenerationOptions,
  onPartial: (result: GenerationResult) => void,
): Promise<GenerationResult | RuntimeFailure> {
  // A schema object does not survive JSON.stringify: send its input JSON Schema instead.
  const { schema, ...plainOptions } = options;
  const wireOptions = schema ? { ...plainOptions, jsonSchema: inputJsonSchema(schema, 'useAIGeneration') } : plainOptions;
  let response: Response;
  try {
    response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        ...wireOptions,
      }),
    });
  } catch (error) {
    return connectionFailure(error);
  }

  if (!response.ok) return readFailureResponse(response);
  if (options.type === 'stream' && response.body) return readTextStream(response.body, onPartial);

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return connectionFailure(error);
  }
  return parse(generationResponseSchema, text);
}

/**
 * Hook for AI content generation
 */
export function useAIGeneration(options: UseAIGenerationOptions = {}): UseAIGenerationReturn {
  const { apiEndpoint = '/api/ai/generate', defaultOptions = {}, onSuccess, onError } = options;

  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [error, setError] = useState<RuntimeFailure | null>(null);

  const generate = useCallback(
    async (prompt: string, generationOptions?: GenerationOptions) => {
      setIsGenerating(true);
      setError(null);

      try {
        const outcome = await requestGeneration(apiEndpoint, prompt, { ...defaultOptions, ...generationOptions }, setResult);
        if (isFailure(outcome)) {
          setError(outcome);
          onError?.(outcome);
          return outcome;
        }
        setResult(outcome);
        onSuccess?.(outcome);
        return outcome;
      } finally {
        setIsGenerating(false);
      }
    },
    [apiEndpoint, defaultOptions, onSuccess, onError],
  );

  const clear = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return {
    generate,
    isGenerating,
    result,
    error,
    clear,
  };
}
