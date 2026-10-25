/**
 * The runtime schemas of the capabilities. Internal: the capabilities parse with them, and `@arki/ai/zod`
 * offers them to callers (request bodies, stored documents). Each capability module declares the TS type
 * as the source, so its public types carry no Zod; `../zod.test.ts` locks each schema to its type.
 */
import { z } from 'zod';

/** `AskQuestion` (`./ask`). */
export const askQuestionSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  at: z.number().finite().nonnegative(),
  sourceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  history: z
    .array(z.object({ question: z.string().max(2000), answer: z.string().max(8000) }))
    .max(6)
    .default([]),
});

/** `QueueOrderInput` (`./queue`). */
export const queueOrderSchema = z
  .object({
    episodes: z
      .array(
        z.object({
          id: z.string().min(1).max(2000),
          mediaKey: z.string().regex(/^[a-f0-9]{64}$/),
          sourceHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          title: z.string().max(2000),
          summary: z.string().max(12000),
        }),
      )
      .min(2)
      .max(40),
  })
  .refine(v => new Set(v.episodes.map(e => e.id)).size === v.episodes.length, 'Duplicate episodes');

/** `HopSelection` (`./podhop`). */
export const hopSelectionSchema = z.object({
  language: z.enum(['en', 'ro', 'es', 'de']),
  mixedLanguage: z.boolean(),
  moments: z
    .array(
      z.object({
        title: z.string().min(1).max(100),
        introduction: z.string().min(1).max(500),
        evidence: z.string().min(1).max(600),
      }),
    )
    .min(1)
    .max(6),
});

/** `TranscriptDocument` and `AnalysisDocument` (`./episode-analysis`). */
export const transcriptDocumentSchema = z.object({
  language: z.string().min(2).max(40),
  duration: z.number().finite().positive(),
  segments: z
    .array(
      z.object({
        start: z.number().finite().nonnegative(),
        end: z.number().finite().positive(),
        text: z.string().min(1),
        speaker: z.string().min(1),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .min(1)
    .max(100000),
  provider: z.string(),
  model: z.string(),
});
export const passageSchema = z.object({
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  title: z.string().min(1),
  evidence: z.string().min(1),
});
export const analysisDocumentSchema = z.object({
  summary: z.string().min(1),
  chapters: z.array(passageSchema).min(1).max(1000),
  topics: z.array(z.string()).max(100),
  entities: z
    .array(z.object({ name: z.string(), type: z.string(), evidence: z.string(), start: z.number().nonnegative() }))
    .max(1000),
  pips: z.array(passageSchema).max(1000),
  speakers: z
    .array(z.object({ id: z.string(), name: z.string().nullable(), evidence: z.string().nullable() }))
    .max(1000),
  model: z.string(),
  version: z.string(),
});
