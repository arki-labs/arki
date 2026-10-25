import { expectTypeOf, it } from 'vitest';

import type { z } from '@arki/contracts';

import type { StructuredGenerator } from './ai-service/structured-generation';
import type { AskQuestion } from './capabilities/ask';
import type { AnalysisDocument, TranscriptDocument } from './capabilities/episode-analysis';
import type { HopSelection } from './capabilities/podhop';
import type { QueueOrderInput } from './capabilities/queue';
import type { detectionPatternSchema, piiPatternSchema, sanitizerConfigSchema } from './safety/schemas';
import type { DetectionPattern, PIIPattern, SanitizerConfig } from './safety/types';
import type {
  AIServiceConfig,
  ChatMessage,
  Document,
  GenerationOptions,
  QdrantConfig,
  RAGServiceConfig,
  SearchOptions,
  SearchSettings,
  VectorProviderConfig,
} from './validation';
import type * as zodEntry from './zod';

/** What one `StructuredGenerator` task resolves to. */
type TaskResult<K extends keyof StructuredGenerator> = StructuredGenerator[K] extends (
  ...args: never[]
) => Promise<infer R>
  ? R
  : never;

// Every public entry but `./zod` exposes plain TS types, written once as the source. The schema that parses the
// same data lives in `./zod`. These exact two-way tests are what keeps the two equal: a field added to one side
// only, a widened enum or a dropped `optional` fails here instead of reaching a caller as a type that lies.
it('every capability schema in ./zod parses to exactly its public type', () => {
  expectTypeOf<z.output<typeof zodEntry.askQuestionSchema>>().toEqualTypeOf<AskQuestion>();
  expectTypeOf<z.output<typeof zodEntry.queueOrderSchema>>().toEqualTypeOf<QueueOrderInput>();
  expectTypeOf<z.output<typeof zodEntry.hopSelectionSchema>>().toEqualTypeOf<HopSelection>();
  expectTypeOf<z.output<typeof zodEntry.transcriptDocumentSchema>>().toEqualTypeOf<TranscriptDocument>();
  expectTypeOf<z.output<typeof zodEntry.analysisDocumentSchema>>().toEqualTypeOf<AnalysisDocument>();
  expectTypeOf<z.output<typeof zodEntry.passageSchema>>().toEqualTypeOf<AnalysisDocument['chapters'][number]>();
});

it('every validation schema in ./zod parses to exactly its public type', () => {
  expectTypeOf<z.output<typeof zodEntry.qdrantConfigSchema>>().toEqualTypeOf<QdrantConfig>();
  expectTypeOf<z.output<typeof zodEntry.vectorProviderConfigSchema>>().toEqualTypeOf<VectorProviderConfig>();
  expectTypeOf<z.output<typeof zodEntry.searchSettingsSchema>>().toEqualTypeOf<SearchSettings>();
  // `SearchOptions` is `SearchSettings & {...}`; `branded` compares the intersection by its resolved shape.
  expectTypeOf<z.output<typeof zodEntry.searchOptionsSchema>>().branded.toEqualTypeOf<SearchOptions>();
  expectTypeOf<z.output<typeof zodEntry.ragServiceConfigSchema>>().toEqualTypeOf<RAGServiceConfig>();
  expectTypeOf<z.output<typeof zodEntry.aiServiceConfigSchema>>().toEqualTypeOf<AIServiceConfig>();
  expectTypeOf<z.output<typeof zodEntry.generationOptionsSchema>>().toEqualTypeOf<GenerationOptions>();
  expectTypeOf<z.output<typeof zodEntry.documentSchema>>().toEqualTypeOf<Document>();
  expectTypeOf<z.output<typeof zodEntry.documentsSchema>>().toEqualTypeOf<Document[]>();
  expectTypeOf<z.output<typeof zodEntry.chatMessageSchema>>().toEqualTypeOf<ChatMessage>();
});

it('the sanitizer schemas parse to exactly the safety types', () => {
  expectTypeOf<z.output<typeof detectionPatternSchema>>().toEqualTypeOf<DetectionPattern>();
  expectTypeOf<z.output<typeof piiPatternSchema>>().toEqualTypeOf<PIIPattern>();
  expectTypeOf<z.output<typeof sanitizerConfigSchema>>().toEqualTypeOf<SanitizerConfig>();
});

it('each StructuredGenerator task resolves to exactly what its CommonSchemas entry parses', () => {
  expectTypeOf<TaskResult<'generateSummary'>>().toEqualTypeOf<z.output<typeof zodEntry.CommonSchemas.summary>>();
  expectTypeOf<TaskResult<'answerQuestion'>>().toEqualTypeOf<z.output<typeof zodEntry.CommonSchemas.qa>>();
  expectTypeOf<TaskResult<'classifyText'>>().toEqualTypeOf<z.output<typeof zodEntry.CommonSchemas.classification>>();
  expectTypeOf<TaskResult<'extractEntities'>>().toEqualTypeOf<z.output<typeof zodEntry.CommonSchemas.entities>>();
  expectTypeOf<TaskResult<'analyzeSentiment'>>().toEqualTypeOf<z.output<typeof zodEntry.CommonSchemas.sentiment>>();
  expectTypeOf<TaskResult<'translateText'>>().toEqualTypeOf<z.output<typeof zodEntry.CommonSchemas.translation>>();
  expectTypeOf<TaskResult<'generateCode'>>().toEqualTypeOf<z.output<typeof zodEntry.CommonSchemas.code>>();
});
