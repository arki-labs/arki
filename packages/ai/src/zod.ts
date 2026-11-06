/**
 * The Zod schemas of `@arki/ai`, for callers that parse with them: request bodies (`askQuestionSchema`,
 * `queueOrderSchema`), stored documents (`transcriptDocumentSchema`, `analysisDocumentSchema`), config, and the bodies the
 * React hooks read (`searchResultSchema`, `generationResultSchema`).
 *
 * The other entries expose plain TS types only. Each type is the source; `zod.test.ts` locks every schema
 * here to its type with an exact two-way type test (`hooks.test.ts` for the React bodies), so the two cannot drift.
 */
export { CommonSchemas } from './ai-service/structured-generation-schemas.js';
export {
  analysisDocumentSchema,
  askQuestionSchema,
  hopSelectionSchema,
  passageSchema,
  queueOrderSchema,
  transcriptDocumentSchema,
} from './capabilities/schemas.js';
export { generationResultSchema, searchResultSchema } from './react/hooks/schemas.js';
export {
  aiServiceConfigSchema,
  chatMessageSchema,
  documentSchema,
  documentsSchema,
  generationOptionsSchema,
  qdrantConfigSchema,
  ragServiceConfigSchema,
  searchOptionsSchema,
  searchSettingsSchema,
  vectorProviderConfigSchema,
} from './validation-schemas.js';
