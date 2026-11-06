/**
 * The Zod schemas of the React hooks' responses, offered to callers by `@arki/ai/zod`. They live apart from
 * the hooks so `./react` names no Zod type (`TYPES_E001`). `hooks.test.ts` locks each to its type both ways.
 */
import { z } from 'zod';

import { GENERATION_TYPES } from './generation-types.js';

/** A `SearchResult` (`useSemanticSearch.tsx`) as the search endpoint sends it. A two-way type test locks it to the type. */
export const searchResultSchema = z.object({
  id: z.string(),
  score: z.number(),
  data: z.record(z.string(), z.unknown()).optional(),
  highlights: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** A `GenerationResult` (`useAIGeneration.tsx`), the body of a non-stream response. A two-way type test locks it to the type. */
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
