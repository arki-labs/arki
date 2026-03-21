/**
 * Content Analysis Capability
 *
 * Extracts multi-level summaries, key takeaways, named entities, topic tags,
 * reading metadata, and a rewritten title from any long-form text content.
 *
 * Designed for newsletters and articles but applicable to any dense prose.
 */

import { z } from '@arki/contracts';

import { createLLMProvider, type LLMProviderConfig } from '../ai-service/factory';
import type { StructuredLLMProvider } from '../ai-service/types';

// ── Types ─────────────────────────────────────────────────────

export type ContentType =
  | 'newsletter'
  | 'article'
  | 'research'
  | 'tutorial'
  | 'opinion'
  | 'news'
  | 'other';

export type ContentCategory =
  | 'technology'
  | 'business'
  | 'science'
  | 'health'
  | 'politics'
  | 'culture'
  | 'finance'
  | 'education'
  | 'sports'
  | 'other';

export type ImportanceLevel = 'critical' | 'high' | 'medium' | 'low';

export type EntityType = 'person' | 'organization' | 'product' | 'location' | 'concept';

export type ContentAnalysis = {
  /** One-sentence summary — the single most important thing to know. */
  summaryTldr?: string;
  /** 2–3 sentence summary covering the main argument, evidence, and conclusion. */
  summaryStandard: string;
  /** Full breakdown: context, core claims, evidence, implications, and caveats. */
  summaryDetailed?: string;
  /** Table of contents: one entry per logical section. */
  toc?: Array<{
    heading: string;
    keyPoint: string;
    estimatedReadTime?: string;
  }>;
  /** Concrete, actionable insights worth remembering. */
  takeaways?: Array<{
    text: string;
    importance: ImportanceLevel;
    category: string;
  }>;
  /** Named entities central to the content. */
  entities?: Array<{
    name: string;
    type: EntityType;
    context: string;
  }>;
  /** A clearer, more specific title. */
  rewrittenTitle: string;
  /** Primary content format. */
  contentType?: ContentType;
  /** 3–5 lowercase topic tags. */
  topics: string[];
  /** Single best-fit category. */
  category?: ContentCategory;
  /** Estimated reading time in minutes. */
  readingTimeMinutes?: number;
  /** Technical complexity (1 = very accessible, 10 = expert-only). */
  complexityScore?: number;
};

// ── Schema ────────────────────────────────────────────────────

export const ContentAnalysisSchema = z.object({
  summaryTldr: z
    .string()
    .describe('One-sentence summary — the single most important thing to know.')
    .optional(),
  summaryStandard: z
    .string()
    .describe('2-3 sentence summary covering the main argument, evidence, and conclusion.'),
  summaryDetailed: z
    .string()
    .describe('Full breakdown: context, core claims, supporting evidence, implications, and caveats.')
    .optional(),
  toc: z
    .array(
      z.object({
        heading: z.string().describe('Section heading as it appears (or would appear) in the text.'),
        keyPoint: z.string().describe('The single most important point made in this section.'),
        estimatedReadTime: z.string().describe('Rough read time, e.g. "1 min".').optional(),
      }),
    )
    .describe('Table of contents: one entry per logical section.')
    .optional(),
  takeaways: z
    .array(
      z.object({
        text: z.string().describe('A concrete, actionable insight worth remembering.'),
        importance: z
          .enum(['critical', 'high', 'medium', 'low'])
          .describe('Relative importance of this takeaway.'),
        category: z
          .string()
          .describe('Short thematic category, e.g. "strategy", "data", "warning".'),
      }),
    )
    .describe('3–7 key takeaways, ordered by importance.')
    .optional(),
  entities: z
    .array(
      z.object({
        name: z.string().describe('The entity name as it appears in the text.'),
        type: z
          .enum(['person', 'organization', 'product', 'location', 'concept'])
          .describe('Entity type.'),
        context: z.string().describe('Why this entity is mentioned — one concise sentence.'),
      }),
    )
    .describe('Named entities that are central to the content.')
    .optional(),
  rewrittenTitle: z
    .string()
    .describe('A clearer, more specific title. A busy reader should understand the article from the title alone.'),
  contentType: z
    .enum(['newsletter', 'article', 'research', 'tutorial', 'opinion', 'news', 'other'])
    .describe('The primary content format.')
    .optional(),
  topics: z
    .array(z.string())
    .min(1)
    .max(5)
    .describe('3–5 lowercase topic tags, e.g. ["ai", "machine-learning", "openai"].'),
  category: z
    .enum(['technology', 'business', 'science', 'health', 'politics', 'culture', 'finance', 'education', 'sports', 'other'])
    .describe('The single best-fit category for this content.')
    .optional(),
  readingTimeMinutes: z
    .number()
    .int()
    .positive()
    .describe('Estimated reading time in minutes based on the original content length.')
    .optional(),
  complexityScore: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe('How technically dense the content is (1 = very accessible, 10 = expert-only).')
    .optional(),
});

// ── System prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a professional content analyst. Your task is to extract structured intelligence from long-form content.

Guidelines:
- summaryTldr: One sentence capturing the absolute essence. Omit fluff.
- summaryStandard: 2-3 sentences. Cover the main argument, key evidence, and conclusion.
- summaryDetailed: Full breakdown for readers who want depth. Include context, core claims, evidence, implications, caveats.
- toc: One entry per major section/theme. Include only if the content has clear structure.
- takeaways: Concrete, actionable insights. 3-7 items ordered by importance. Avoid vague observations.
- entities: Only entities that are central to understanding the content.
- rewrittenTitle: Write for a busy reader — they should understand the article from the title alone.
- topics: 3-5 lowercase tags. Specific is better than generic ("llm-fine-tuning" > "ai").
- complexityScore: 1 = any reader, 10 = requires deep domain expertise.`;

// ── Prompt builder ────────────────────────────────────────────

function buildPrompt(params: { title: string; contentText: string; wordCount: number }): string {
  return `Title: ${params.title}
Word count: ~${params.wordCount}

--- CONTENT START ---
${params.contentText}
--- CONTENT END ---

Extract structured intelligence from this content.`;
}

// ── Capability function ───────────────────────────────────────

/**
 * Extract structured intelligence from long-form text content.
 *
 * @param text - The full content text (will be truncated at 40,000 chars).
 * @param title - The original content title.
 * @param wordCount - Approximate word count (used in prompt context).
 * @param provider - LLM provider to use. Defaults to `createLLMProvider({ temperature: 0.3 })`.
 * @returns Structured content analysis with summaries, takeaways, entities, and metadata.
 */
export async function analyzeContent(
  text: string,
  title: string,
  wordCount: number,
  provider?: StructuredLLMProvider,
  config?: LLMProviderConfig,
): Promise<ContentAnalysis> {
  const llm = provider ?? createLLMProvider({ temperature: 0.3, ...config });
  const truncatedText = text.length > 40_000 ? text.slice(0, 40_000) : text;

  return llm.generateStructuredData(
    buildPrompt({ title, contentText: truncatedText, wordCount }),
    ContentAnalysisSchema,
    { systemPrompt: SYSTEM_PROMPT, temperature: 0.3 },
  );
}
