/**
 * Structured Generation Utilities
 * Helper functions for common structured generation tasks
 */

import type { StandardSchemaV1 } from '@arki/schema';
import { z } from '@arki/contracts';
import type { ProviderFailure } from '../failures';
import type { StructuredLLMProvider } from './types';
import { CommonSchemas } from './structured-generation-schemas';

export type StructuredGenerationOptions = {
  temperature?: number;
  maxRetries?: number;
  systemPrompt?: string;
}

// The result of each `StructuredGenerator` task. The schemas the model answers against are `CommonSchemas`
// (`./structured-generation-schemas`); `../zod.test.ts` locks every type below to its schema.
type StructuredSummary = { title: string; summary: string; keyPoints: string[]; tags?: string[] };
type QuestionAnswer = { question: string; answer: string; confidence: number; sources?: string[] };
type TextClassification = { category: string; subcategory?: string; confidence: number; reasoning?: string };
type ExtractedEntities = { entities: { text: string; type: string; startIndex?: number; endIndex?: number }[] };
type SentimentAnalysis = {
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  score: number;
  emotions?: string[];
  reasoning?: string;
};
type Translation = { originalText: string; translatedText: string; targetLanguage: string; confidence?: number };
type GeneratedCode = { language: string; code: string; explanation?: string; dependencies?: string[] };

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
  ): Promise<StructuredSummary | ProviderFailure> {
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
  ): Promise<QuestionAnswer | ProviderFailure> {
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
  ): Promise<TextClassification | ProviderFailure> {
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
  ): Promise<ExtractedEntities | ProviderFailure> {
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
  ): Promise<SentimentAnalysis | ProviderFailure> {
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
  ): Promise<Translation | ProviderFailure> {
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
  ): Promise<GeneratedCode | ProviderFailure> {
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
  async generateCustom<S extends StandardSchemaV1>(
    prompt: string,
    schema: S,
    options: StructuredGenerationOptions = {}
  ) {
    return this.provider.generateStructuredData(
      prompt,
      schema,
      options
    );
  }
}
