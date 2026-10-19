/**
 * Intent Classification Capability
 *
 * Classifies a user message to determine the retrieval strategy for a
 * RAG-enabled assistant (needs semantic search? time-filtered? general?).
 *
 * Reusable by any app that routes user queries through an LLM copilot.
 */

import { z } from '@arki/contracts';

import { createLLMProvider, type LLMProviderConfig } from '../ai-service/factory';
import type { StructuredLLMProvider } from '../ai-service/types';

// ── Schema ────────────────────────────────────────────────────

const IntentSchema = z.object({
  /** The detected user intent category. */
  intent: z.enum(['search', 'synthesize', 'compare', 'organize', 'transform', 'general']),
  /** Short duration strings like "7d", "30d", "1d". */
  timeFilter: z.string().optional(),
  /** Optional topic keywords extracted from the message. */
  topicHint: z.string().optional(),
  /** Whether the question requires retrieval against the user's library. */
  requiresRAG: z.boolean(),
});

export type ClassifiedIntent = z.infer<typeof IntentSchema>;
export type IntentType = ClassifiedIntent['intent'];

// ── System prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an intent classifier for a reading assistant.

Classify the user's message into one of these intents:
- "search": User wants to find specific content in their library
- "synthesize": User wants a summary or synthesis of multiple pieces of content
- "compare": User wants to compare ideas or content from different sources
- "organize": User wants to categorize, tag, or organize their content
- "transform": User wants content transformed (e.g., as a list, bullet points, translated)
- "general": User has a general knowledge question not tied to their library

Set "requiresRAG" to false only when:
- The question is purely about general knowledge and does not reference "my newsletters", "my library", "I read", "what did X say", etc.
- The user explicitly says "in general" or "outside my sources"

Otherwise, always set "requiresRAG" to true — it is safer to retrieve context than to miss relevant content.

For timeFilter, extract any time references (e.g., "7d" for "this week", "30d" for "this month", "1d" for "today").
For topicHint, extract any topic keywords mentioned.`;

// ── Capability function ───────────────────────────────────────

/**
 * Classify a user message for RAG pipeline routing.
 *
 * @param message - The raw user message text.
 * @param provider - LLM provider to use. Defaults to `createLLMProvider({ temperature: 0 })`.
 * @returns Structured intent classification with RAG routing decision.
 */
export async function classifyIntent(
  message: string,
  provider?: StructuredLLMProvider,
  config?: LLMProviderConfig,
): Promise<ClassifiedIntent> {
  const llm = provider ?? createLLMProvider({ temperature: 0, ...config });
  return llm.generateStructuredData(message, IntentSchema, {
    systemPrompt: SYSTEM_PROMPT,
    temperature: 0,
  });
}
