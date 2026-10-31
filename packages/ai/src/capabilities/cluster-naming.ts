/**
 * Cluster Naming Capability
 *
 * Generates human-readable names, descriptions, emojis, and structural
 * metadata for topic clusters built from article/document titles.
 *
 * Reusable by any app that clusters content (newsletters, documents, notes).
 */

import { z } from '@arki/contracts';

import { createLLMProvider  } from '../ai-service/factory.js';
import type {LLMProviderConfig} from '../ai-service/factory.js';
import type { ProviderFailure } from '../failures.js';
import type { StructuredLLMProvider } from '../ai-service/types.js';

// ── Types ─────────────────────────────────────────────────────

export type ClusterType = 'topic' | 'event' | 'entity';

export type ClusterName = {
  /** Concise human-readable name (3–6 words, title-cased). */
  name: string;
  /** One-sentence description of what content belongs in this cluster. */
  description: string;
  /** Single representative emoji for the cluster topic. */
  emoji: string;
  /**
   * Structural classification:
   * - "event": time-bounded burst (≤14 days, ≥5 items)
   * - "entity": centred on a specific named real-world entity
   * - "topic": persistent, recurring subject area
   */
  clusterType: ClusterType;
  /**
   * Suggested hierarchy depth.
   * 0 = top-level, 1 = sub-cluster of a broader topic.
   */
  suggestedDepth: 0 | 1;
};

export type ClusterNamingContext = {
  /** Earliest item timestamp in the cluster. */
  firstItemAt?: Date;
  /** Most recent item timestamp in the cluster. */
  lastItemAt?: Date;
  /** Up to 10 representative named entities from cluster members. */
  keyEntities?: string[];
};

// ── Schema ────────────────────────────────────────────────────

const ClusterNameSchema = z.object({
  name: z.string().describe('A concise, human-readable cluster name (3-6 words max).'),
  description: z.string().describe('A single sentence describing what content belongs in this cluster.'),
  emoji: z.string().describe('A single relevant emoji that best represents the cluster topic.'),
  clusterType: z
    .enum(['topic', 'event', 'entity'])
    .describe(
      '"event": time-bounded burst (all articles within 14 days, ≥5 items). ' +
      '"entity": centred on a specific named real-world entity. ' +
      '"topic": default for persistent, recurring subject areas.',
    ),
  suggestedDepth: z
    .number()
    .int()
    .min(0)
    .max(1)
    .describe('0 = top-level cluster, 1 = looks like a sub-cluster of a broader topic.')
    .transform(n => n as 0 | 1),
});

// ── System prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are a topic cluster naming assistant. Given a list of article titles, generate a
concise name, one-sentence description, a single emoji, a cluster type, and a hierarchy depth hint.

Rules:
1. Name must be 3-6 words, title-cased, immediately recognizable. No "Miscellaneous" or "General".
2. Description: one sentence, max 100 characters.
3. Emoji: single Unicode character — no sequences or variants.
4. If an existing name is provided, improve only if the articles clearly suggest something more specific.
5. clusterType:
   - "event": time-bounded burst (all within 14-day window, ≥5 items) covering a specific event.
   - "entity": centred on a specific named person, company, or product.
   - "topic": default for persistent, recurring subject areas.
6. suggestedDepth = 1 only if this clearly looks like a narrow sub-topic of a broader topic. Otherwise 0.`;

// ── Capability function ───────────────────────────────────────

/**
 * Generate a human-readable name and metadata for a content cluster.
 *
 * @param sampleTitles - Up to 10 representative article/document titles.
 * @param provider - LLM provider to use. Defaults to `createLLMProvider({ temperature: 0.4 })`.
 * @param existingName - Current cluster name, if any (used for refinement).
 * @param context - Optional temporal and entity context for better classification.
 * @returns Structured cluster name with type and depth metadata.
 */
export async function nameCluster(
  sampleTitles: string[],
  provider?: StructuredLLMProvider,
  existingName?: string,
  context?: ClusterNamingContext,
  config?: LLMProviderConfig,
): Promise<ClusterName | ProviderFailure> {
  const llm = provider ?? createLLMProvider({ temperature: 0.4, ...config });

  const titlesBlock = sampleTitles
    .slice(0, 10)
    .map((t, i) => `${i + 1}. ${t}`)
    .join('\n');

  const parts: string[] = [];
  if (existingName) parts.push(`Current cluster name: "${existingName}"`);
  if (context?.firstItemAt && context?.lastItemAt) {
    parts.push(
      `Time window: ${context.firstItemAt.toISOString().slice(0, 10)} → ${context.lastItemAt.toISOString().slice(0, 10)}`,
    );
  }
  if (context?.keyEntities && context.keyEntities.length > 0) {
    parts.push(`Key entities: ${context.keyEntities.slice(0, 10).join(', ')}`);
  }

  const contextBlock = parts.length > 0 ? `${parts.join('\n')}\n\n` : '';

  const prompt = `${contextBlock}Article titles:\n\n${titlesBlock}\n\nGenerate a cluster name, description, emoji, clusterType, and suggestedDepth.`;

  return llm.generateStructuredData(prompt, ClusterNameSchema, {
    systemPrompt: SYSTEM_PROMPT,
    temperature: 0.4,
  });
}
