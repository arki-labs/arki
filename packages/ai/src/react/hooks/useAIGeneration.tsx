'use client';

/**
 * React hook for AI content generation
 */

import { useCallback, useState } from 'react';

import type { z } from '@arki/contracts';

export interface GenerationOptions {
  type?: 'text' | 'structured' | 'stream';
  schema?: z.ZodType<unknown>; // Zod schema for structured generation
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GenerationResult {
  content: string | Record<string, unknown>;
  type: 'text' | 'structured' | 'stream';
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  metadata?: Record<string, string | number | boolean>;
}

export interface UseAIGenerationOptions {
  apiEndpoint?: string;
  defaultOptions?: GenerationOptions;
  onSuccess?: (result: GenerationResult) => void;
  onError?: (error: Error) => void;
}

export interface UseAIGenerationReturn {
  generate: (prompt: string, options?: GenerationOptions) => Promise<GenerationResult | null>;
  isGenerating: boolean;
  result: GenerationResult | null;
  error: Error | null;
  clear: () => void;
}

/**
 * Hook for AI content generation
 */
export function useAIGeneration(options: UseAIGenerationOptions = {}): UseAIGenerationReturn {
  const { apiEndpoint = '/api/ai/generate', defaultOptions = {}, onSuccess, onError } = options;

  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const generate = useCallback(
    async (prompt: string, generationOptions?: GenerationOptions) => {
      setIsGenerating(true);
      setError(null);

      const finalOptions = {
        ...defaultOptions,
        ...generationOptions,
      };

      try {
        const response = await fetch(apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt,
            ...finalOptions,
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        if (finalOptions.type === 'stream' && response.body) {
          // Handle streaming
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let fullText = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              const chunk = decoder.decode(value);
              fullText += chunk;
              setResult({ content: fullText, type: 'stream' }); // Update result incrementally
            }
          } finally {
            reader.releaseLock();
          }

          const streamResult: GenerationResult = {
            content: fullText,
            type: 'stream',
          };
          setResult(streamResult);
          if (onSuccess) onSuccess(streamResult);
          return streamResult;
        } else {
          // Handle non-streaming response
          const data: GenerationResult = await response.json();
          setResult(data);

          if (onSuccess) onSuccess(data);
          return data;
        }
      } catch (err) {
        const error = err as Error;
        setError(error);
        if (onError) onError(error);
        throw error;
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
