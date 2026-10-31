/**
 * Connection Classification Capability
 *
 * Classifies the semantic relationship between two text passages.
 * Used to enrich knowledge graphs, highlight networks, and note-linking features.
 *
 * Reusable by any app that stores pairwise relationships between content nodes.
 */

import { z } from '@arki/contracts';

import { createLLMProvider  } from '../ai-service/factory.js';
import type {LLMProviderConfig} from '../ai-service/factory.js';
import type { ProviderFailure } from '../failures.js';
import type { StructuredLLMProvider } from '../ai-service/types.js';

// ── Types ─────────────────────────────────────────────────────

export type ConnectionType = 'related' | 'contradicts' | 'supports' | 'extends';

export type ConnectionClassification = {
  /** The semantic relationship between the two passages. */
  connectionType: ConnectionType;
  /** One-sentence explanation (max 200 chars). */
  explanation: string;
  /** Classification confidence score (0–1). */
  confidence: number;
};

// ── Schema ────────────────────────────────────────────────────

const ConnectionClassificationSchema = z.object({
  connectionType: z.enum(['related', 'contradicts', 'supports', 'extends']),
  explanation: z.string().max(200),
  confidence: z.number().min(0).max(1),
});

// ── System prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are a semantic relationship classifier. Given two text passages from different sources,
classify the relationship between them and explain it concisely.

Rules:
1. "contradicts": The passages make opposing or conflicting claims about the same topic.
2. "supports": One passage provides evidence, context, or agreement for claims in the other.
3. "extends": One passage builds on, deepens, or adds nuance to the other's ideas.
4. "related": The passages share a topic but don't clearly contradict, support, or extend each other.
5. Keep explanations to one concise sentence (max 200 characters).
6. Base classification only on the content provided — do not speculate.`;

// ── Prompt builder ────────────────────────────────────────────

function buildPrompt(textA: string, textB: string): string {
  return `\
Classify the semantic relationship between these two passages.

Passage A:
"${textA}"

Passage B:
"${textB}"

Determine whether Passage A contradicts, supports, extends, or is simply related to Passage B.`;
}

// ── Capability function ───────────────────────────────────────

/**
 * Classify the semantic relationship between two text passages.
 *
 * @param textA - The first passage (source).
 * @param textB - The second passage (target).
 * @param provider - LLM provider to use. Defaults to `createLLMProvider({ temperature: 0.2 })`.
 * @returns Structured connection type, explanation, and confidence score.
 */
export async function classifyConnection(
  textA: string,
  textB: string,
  provider?: StructuredLLMProvider,
  config?: LLMProviderConfig,
): Promise<ConnectionClassification | ProviderFailure> {
  const llm = provider ?? createLLMProvider({ temperature: 0.2, ...config });

  return llm.generateStructuredData(buildPrompt(textA, textB), ConnectionClassificationSchema, {
    systemPrompt: SYSTEM_PROMPT,
    temperature: 0.2,
  });
}
