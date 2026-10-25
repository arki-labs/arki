/**
 * The runtime schemas `StructuredGenerator` asks the model for. Internal to `./structured-generation`, whose
 * method results are plain TS types; `@arki/ai/zod` offers `CommonSchemas` to callers, and `../zod.test.ts`
 * locks each schema to its method's result type.
 */
import { z } from '@arki/contracts';

/**
 * Common schema definitions for structured generation
 */
export const CommonSchemas = {
  /**
   * Summary generation schema
   */
  summary: z.object({
    title: z.string(),
    summary: z.string(),
    keyPoints: z.array(z.string()),
    tags: z.array(z.string()).optional(),
  }),

  /**
   * Question-Answer schema
   */
  qa: z.object({
    question: z.string(),
    answer: z.string(),
    confidence: z.number().min(0).max(1),
    sources: z.array(z.string()).optional(),
  }),

  /**
   * Classification schema
   */
  classification: z.object({
    category: z.string(),
    subcategory: z.string().optional(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().optional(),
  }),

  /**
   * Entity extraction schema
   */
  entities: z.object({
    entities: z.array(
      z.object({
        text: z.string(),
        type: z.string(),
        startIndex: z.number().optional(),
        endIndex: z.number().optional(),
      }),
    ),
  }),

  /**
   * Sentiment analysis schema
   */
  sentiment: z.object({
    sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']),
    score: z.number().min(-1).max(1),
    emotions: z.array(z.string()).optional(),
    reasoning: z.string().optional(),
  }),

  /**
   * Translation schema
   */
  translation: z.object({
    originalText: z.string(),
    translatedText: z.string(),
    targetLanguage: z.string(),
    confidence: z.number().min(0).max(1).optional(),
  }),

  /**
   * Code generation schema
   */
  code: z.object({
    language: z.string(),
    code: z.string(),
    explanation: z.string().optional(),
    dependencies: z.array(z.string()).optional(),
  }),
};
