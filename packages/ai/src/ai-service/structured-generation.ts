/**
 * Structured Generation Utilities
 * Helper functions for common structured generation tasks
 */

import { z } from '@arki/contracts';
import type { StructuredLLMProvider } from './types';

export type StructuredGenerationOptions = {
  temperature?: number;
  maxRetries?: number;
  systemPrompt?: string;
}

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
    entities: z.array(z.object({
      text: z.string(),
      type: z.string(),
      startIndex: z.number().optional(),
      endIndex: z.number().optional(),
    })),
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

/**
 * Helper class for common structured generation tasks
 */
/**
 * Helper class for common structured generation tasks.
 * Accepts any `StructuredLLMProvider` — use `createLLMProvider()` to obtain one.
 */
export class StructuredGenerator {
  constructor(private provider: StructuredLLMProvider) {}

  /**
   * Generate a summary of text
   */
  async generateSummary(
    text: string,
    options: StructuredGenerationOptions = {}
  ) {
    const prompt = `Please provide a comprehensive summary of the following text:

"${text}"

Include a title, main summary, and key points.`;

    return this.provider.generateStructuredData(
      prompt,
      CommonSchemas.summary,
      {
        ...options,
        systemPrompt: options.systemPrompt || 'You are a helpful assistant that creates clear, concise summaries.',
      }
    );
  }

  /**
   * Answer a question based on context
   */
  async answerQuestion(
    question: string,
    context: string,
    options: StructuredGenerationOptions = {}
  ) {
    const prompt = `Based on the following context, answer the question.

Context: "${context}"

Question: "${question}"

Provide your answer with a confidence score.`;

    return this.provider.generateStructuredData(
      prompt,
      CommonSchemas.qa,
      {
        ...options,
        systemPrompt: options.systemPrompt || 'You are a helpful assistant that answers questions accurately based on provided context.',
      }
    );
  }

  /**
   * Classify text into categories
   */
  async classifyText(
    text: string,
    categories: string[],
    options: StructuredGenerationOptions = {}
  ) {
    const prompt = `Classify the following text into one of these categories: ${categories.join(', ')}

Text: "${text}"

Provide the classification with confidence score and reasoning.`;

    return this.provider.generateStructuredData(
      prompt,
      CommonSchemas.classification,
      {
        ...options,
        systemPrompt: options.systemPrompt || 'You are a text classification expert.',
      }
    );
  }

  /**
   * Extract entities from text
   */
  async extractEntities(
    text: string,
    entityTypes: string[] = [],
    options: StructuredGenerationOptions = {}
  ) {
    const typesHint = entityTypes.length > 0
      ? `Focus on these entity types: ${entityTypes.join(', ')}`
      : 'Extract all relevant entities';

    const prompt = `Extract entities from the following text.
${typesHint}

Text: "${text}"`;

    return this.provider.generateStructuredData(
      prompt,
      CommonSchemas.entities,
      {
        ...options,
        systemPrompt: options.systemPrompt || 'You are an entity extraction expert.',
      }
    );
  }

  /**
   * Analyze sentiment of text
   */
  async analyzeSentiment(
    text: string,
    options: StructuredGenerationOptions = {}
  ) {
    const prompt = `Analyze the sentiment of the following text:

"${text}"

Provide the sentiment classification, score, detected emotions, and reasoning.`;

    return this.provider.generateStructuredData(
      prompt,
      CommonSchemas.sentiment,
      {
        ...options,
        systemPrompt: options.systemPrompt || 'You are a sentiment analysis expert.',
      }
    );
  }

  /**
   * Translate text to another language
   */
  async translateText(
    text: string,
    targetLanguage: string,
    options: StructuredGenerationOptions = {}
  ) {
    const prompt = `Translate the following text to ${targetLanguage}:

"${text}"`;

    return this.provider.generateStructuredData(
      prompt,
      CommonSchemas.translation,
      {
        ...options,
        systemPrompt: options.systemPrompt || `You are a professional translator specializing in ${targetLanguage}.`,
      }
    );
  }

  /**
   * Generate code based on description
   */
  async generateCode(
    description: string,
    language: string,
    options: StructuredGenerationOptions = {}
  ) {
    const prompt = `Generate ${language} code for the following requirement:

"${description}"

Include the code, an explanation, and any required dependencies.`;

    return this.provider.generateStructuredData(
      prompt,
      CommonSchemas.code,
      {
        ...options,
        systemPrompt: options.systemPrompt || `You are an expert ${language} programmer.`,
      }
    );
  }

  /**
   * Generate multiple choice questions
   */
  async generateQuestions(
    content: string,
    count = 5,
    options: StructuredGenerationOptions = {}
  ) {
    const schema = z.object({
      questions: z.array(z.object({
        question: z.string(),
        options: z.array(z.string()),
        correctAnswer: z.number(),
        explanation: z.string(),
      })),
    });

    const prompt = `Generate ${count} multiple choice questions based on the following content:

"${content}"

Each question should have 4 options with one correct answer.`;

    return this.provider.generateStructuredData(
      prompt,
      schema,
      {
        ...options,
        systemPrompt: options.systemPrompt || 'You are an expert educator who creates effective assessment questions.',
      }
    );
  }

  /**
   * Generate custom structured data
   */
  async generateCustom<T>(
    prompt: string,
    schema: z.ZodSchema<T>,
    options: StructuredGenerationOptions = {}
  ) {
    return this.provider.generateStructuredData(
      prompt,
      schema,
      options
    );
  }
}
