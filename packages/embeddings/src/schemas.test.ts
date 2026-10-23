import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { hasJsonSchema, parse } from '@arki/schema';

import { E5_INSTRUCTION } from './instructions.js';

import type { BedrockModelOptions } from './bedrock/index.js';
import type { CohereCompatibleRerankerOptions, CohereModelOptions, CohereRerankerOptions } from './cohere/index.js';
import type { EmbeddingsPluginOptions } from './dot/index.js';
import type { EmbedderOptions } from './embedder.js';
import type { EmbedManyOptions } from './embed.js';
import type { GoogleModelOptions } from './google/index.js';
import type { JinaModelOptions, JinaRerankerOptions } from './jina/index.js';
import type { MistralModelOptions } from './mistral/index.js';
import type { NormalizeTextOptions } from './normalize.js';
import type { OllamaModelOptions } from './ollama/index.js';
import type { OpenAIModelOptions } from './openai/index.js';
import type { OpenAICompatibleModelOptions } from './openai-compatible/index.js';
import type { RerankCacheOptions, RerankCallOptions, RerankOptions } from './rerank/index.js';
import type { SparseEmbedOptions, SparseModelOptions } from './sparse/index.js';
import type { EmbedStreamOptions } from './stream.js';
import type { TeiRerankerOptions } from './tei/index.js';
import type { TransformersModelOptions, TransformersRerankerOptions } from './transformers/index.js';
import type { VoyageModelOptions, VoyageRerankerOptions } from './voyage/index.js';
import { bedrockModelOptionsSchema } from './bedrock/index.js';
import {
  cohereCompatibleRerankerOptionsSchema,
  cohereModelOptionsSchema,
  cohereRerankerOptionsSchema,
} from './cohere/index.js';
import { embeddingsPluginOptionsSchema } from './dot/index.js';
import { embedderOptionsSchema } from './embedder.js';
import { embedManyOptionsSchema } from './embed.js';
import { googleModelOptionsSchema } from './google/index.js';
import { jinaModelOptionsSchema, jinaRerankerOptionsSchema } from './jina/index.js';
import { mistralModelOptionsSchema } from './mistral/index.js';
import { normalizeTextOptionsSchema } from './normalize.js';
import { ollamaModelOptionsSchema } from './ollama/index.js';
import { openaiModelOptionsSchema } from './openai/index.js';
import { openaiCompatibleModelOptionsSchema } from './openai-compatible/index.js';
import { rerankCacheOptionsSchema, rerankCallOptionsSchema, rerankOptionsSchema } from './rerank/index.js';
import { embedOptionsSchema } from './embed.js';
import { sparseEmbedOptionsSchema, sparseModelOptionsSchema } from './sparse/index.js';
import { embedStreamOptionsSchema } from './stream.js';
import { teiRerankerOptionsSchema } from './tei/index.js';
import { transformersModelOptionsSchema, transformersRerankerOptionsSchema } from './transformers/index.js';
import { voyageModelOptionsSchema, voyageRerankerOptionsSchema } from './voyage/index.js';

import type { EmbedOptions, EmbeddingSpace, TokenCount } from './types.js';
import type { embedRequestSchema, spaceSchema, tokenCountSchema } from './schemas.js';

// `EmbedOptions & {...}` and the one flat object a schema outputs are the same shape that TypeScript's
// strict equality tells apart; flattening the intersection compares the fields themselves.
type Flat<Options> = { [Key in keyof Options]: Options[Key] };

describe('schemas', () => {
  // The types are the source; a schema that drifts from them would accept files the types reject.
  it('each schema outputs exactly its type', () => {
    expectTypeOf<z.output<typeof spaceSchema>>().toEqualTypeOf<EmbeddingSpace>();
    expectTypeOf<z.output<typeof tokenCountSchema>>().toEqualTypeOf<TokenCount>();
    type RecordedOptions = Omit<z.output<typeof embedRequestSchema>, 'inputs'>;
    expectTypeOf<RecordedOptions>().toEqualTypeOf<Pick<EmbedOptions, 'purpose' | 'dimensions' | 'quantization' | 'onTooLong'>>();
    expectTypeOf<z.output<typeof embedRequestSchema>['inputs']>().toEqualTypeOf<readonly string[]>();
  });

  // Options are the input a caller writes: a schema stricter or looser than the type would refuse
  // valid setup or let a typo through to the first request.
  it('each options schema reads and outputs exactly its options type', () => {
    // Generic options are locked at `Item = unknown`: their function field is checked as a function.
    expectTypeOf<SchemaInput<typeof embedOptionsSchema>>().toEqualTypeOf<EmbedOptions>();
    expectTypeOf<SchemaOutput<typeof embedOptionsSchema>>().toEqualTypeOf<EmbedOptions>();
    expectTypeOf<SchemaInput<typeof embedManyOptionsSchema>>().toEqualTypeOf<Flat<EmbedManyOptions>>();
    expectTypeOf<SchemaOutput<typeof embedManyOptionsSchema>>().toEqualTypeOf<Flat<EmbedManyOptions>>();
    expectTypeOf<SchemaInput<typeof embedStreamOptionsSchema>>().toEqualTypeOf<Flat<EmbedStreamOptions<unknown>>>();
    expectTypeOf<SchemaOutput<typeof embedStreamOptionsSchema>>().toEqualTypeOf<Flat<EmbedStreamOptions<unknown>>>();
    expectTypeOf<SchemaInput<typeof embedderOptionsSchema>>().toEqualTypeOf<EmbedderOptions>();
    expectTypeOf<SchemaOutput<typeof embedderOptionsSchema>>().toEqualTypeOf<EmbedderOptions>();
    expectTypeOf<SchemaInput<typeof normalizeTextOptionsSchema>>().toEqualTypeOf<NormalizeTextOptions>();
    expectTypeOf<SchemaOutput<typeof normalizeTextOptionsSchema>>().toEqualTypeOf<NormalizeTextOptions>();
    expectTypeOf<SchemaInput<typeof rerankCallOptionsSchema>>().toEqualTypeOf<RerankCallOptions>();
    expectTypeOf<SchemaOutput<typeof rerankCallOptionsSchema>>().toEqualTypeOf<RerankCallOptions>();
    expectTypeOf<SchemaInput<typeof rerankOptionsSchema>>().toEqualTypeOf<RerankOptions<unknown>>();
    expectTypeOf<SchemaOutput<typeof rerankOptionsSchema>>().toEqualTypeOf<RerankOptions<unknown>>();
    expectTypeOf<SchemaInput<typeof rerankCacheOptionsSchema>>().toEqualTypeOf<RerankCacheOptions>();
    expectTypeOf<SchemaOutput<typeof rerankCacheOptionsSchema>>().toEqualTypeOf<RerankCacheOptions>();
    expectTypeOf<SchemaInput<typeof sparseEmbedOptionsSchema>>().toEqualTypeOf<SparseEmbedOptions>();
    expectTypeOf<SchemaOutput<typeof sparseEmbedOptionsSchema>>().toEqualTypeOf<SparseEmbedOptions>();
    expectTypeOf<SchemaInput<typeof sparseModelOptionsSchema>>().toEqualTypeOf<SparseModelOptions>();
    expectTypeOf<SchemaOutput<typeof sparseModelOptionsSchema>>().toEqualTypeOf<SparseModelOptions>();
    expectTypeOf<SchemaInput<typeof embeddingsPluginOptionsSchema>>().toEqualTypeOf<EmbeddingsPluginOptions>();
    expectTypeOf<SchemaOutput<typeof embeddingsPluginOptionsSchema>>().toEqualTypeOf<EmbeddingsPluginOptions>();
    expectTypeOf<SchemaInput<typeof cohereModelOptionsSchema>>().toEqualTypeOf<CohereModelOptions>();
    expectTypeOf<SchemaOutput<typeof cohereModelOptionsSchema>>().toEqualTypeOf<CohereModelOptions>();
    expectTypeOf<SchemaInput<typeof cohereRerankerOptionsSchema>>().toEqualTypeOf<CohereRerankerOptions>();
    expectTypeOf<SchemaOutput<typeof cohereRerankerOptionsSchema>>().toEqualTypeOf<CohereRerankerOptions>();
    expectTypeOf<SchemaInput<typeof cohereCompatibleRerankerOptionsSchema>>().toEqualTypeOf<CohereCompatibleRerankerOptions>();
    expectTypeOf<SchemaOutput<typeof cohereCompatibleRerankerOptionsSchema>>().toEqualTypeOf<CohereCompatibleRerankerOptions>();
    expectTypeOf<SchemaInput<typeof googleModelOptionsSchema>>().toEqualTypeOf<GoogleModelOptions>();
    expectTypeOf<SchemaOutput<typeof googleModelOptionsSchema>>().toEqualTypeOf<GoogleModelOptions>();
    expectTypeOf<SchemaInput<typeof bedrockModelOptionsSchema>>().toEqualTypeOf<BedrockModelOptions>();
    expectTypeOf<SchemaOutput<typeof bedrockModelOptionsSchema>>().toEqualTypeOf<BedrockModelOptions>();
    expectTypeOf<SchemaInput<typeof teiRerankerOptionsSchema>>().toEqualTypeOf<TeiRerankerOptions>();
    expectTypeOf<SchemaOutput<typeof teiRerankerOptionsSchema>>().toEqualTypeOf<TeiRerankerOptions>();
    expectTypeOf<SchemaInput<typeof transformersModelOptionsSchema>>().toEqualTypeOf<TransformersModelOptions>();
    expectTypeOf<SchemaOutput<typeof transformersModelOptionsSchema>>().toEqualTypeOf<TransformersModelOptions>();
    expectTypeOf<SchemaInput<typeof transformersRerankerOptionsSchema>>().toEqualTypeOf<TransformersRerankerOptions>();
    expectTypeOf<SchemaOutput<typeof transformersRerankerOptionsSchema>>().toEqualTypeOf<TransformersRerankerOptions>();
    expectTypeOf<SchemaInput<typeof jinaModelOptionsSchema>>().toEqualTypeOf<JinaModelOptions>();
    expectTypeOf<SchemaOutput<typeof jinaModelOptionsSchema>>().toEqualTypeOf<JinaModelOptions>();
    expectTypeOf<SchemaInput<typeof jinaRerankerOptionsSchema>>().toEqualTypeOf<JinaRerankerOptions>();
    expectTypeOf<SchemaOutput<typeof jinaRerankerOptionsSchema>>().toEqualTypeOf<JinaRerankerOptions>();
    expectTypeOf<SchemaInput<typeof openaiCompatibleModelOptionsSchema>>().toEqualTypeOf<OpenAICompatibleModelOptions>();
    expectTypeOf<SchemaOutput<typeof openaiCompatibleModelOptionsSchema>>().toEqualTypeOf<OpenAICompatibleModelOptions>();
    expectTypeOf<SchemaInput<typeof ollamaModelOptionsSchema>>().toEqualTypeOf<OllamaModelOptions>();
    expectTypeOf<SchemaOutput<typeof ollamaModelOptionsSchema>>().toEqualTypeOf<OllamaModelOptions>();
    expectTypeOf<SchemaInput<typeof voyageModelOptionsSchema>>().toEqualTypeOf<VoyageModelOptions>();
    expectTypeOf<SchemaOutput<typeof voyageModelOptionsSchema>>().toEqualTypeOf<VoyageModelOptions>();
    expectTypeOf<SchemaInput<typeof voyageRerankerOptionsSchema>>().toEqualTypeOf<VoyageRerankerOptions>();
    expectTypeOf<SchemaOutput<typeof voyageRerankerOptionsSchema>>().toEqualTypeOf<VoyageRerankerOptions>();
    expectTypeOf<SchemaInput<typeof mistralModelOptionsSchema>>().toEqualTypeOf<MistralModelOptions>();
    expectTypeOf<SchemaOutput<typeof mistralModelOptionsSchema>>().toEqualTypeOf<MistralModelOptions>();
    expectTypeOf<SchemaInput<typeof openaiModelOptionsSchema>>().toEqualTypeOf<OpenAIModelOptions>();
    expectTypeOf<SchemaOutput<typeof openaiModelOptionsSchema>>().toEqualTypeOf<OpenAIModelOptions>();
  });

  // The two Transformers.js schemas carry a type annotation (the peer's `ProgressCallback` has no
  // portable name), so the type test above checks only that zod's output fits the type. The other
  // direction is here: a field the schema forgot would be stripped by the parse. `Required<>` makes
  // a new options field a compile error until this object sets it.
  it('the Transformers.js schemas keep every options field', () => {
    const progress: unknown[] = [];
    const onProgress = (info: unknown) => {
      progress.push(info);
    };
    const model: Required<TransformersModelOptions> = {
      id: 'onnx-community/embeddinggemma-300m-ONNX',
      revision: 'a'.repeat(40),
      dtype: 'q8',
      device: 'cpu',
      cacheDir: '/models',
      onProgress,
      instruction: E5_INSTRUCTION,
    };
    expect(parse(transformersModelOptionsSchema, model)).toEqual(model);
    const reranker: Required<TransformersRerankerOptions> = {
      id: 'onnx-community/bge-reranker-v2-m3-ONNX',
      revision: 'b'.repeat(40),
      dtype: 'q8',
      device: 'cpu',
      cacheDir: '/models',
      onProgress,
      maxInputTokens: 512,
      instruction: 'Given a query, judge the document',
    };
    expect(parse(transformersRerankerOptionsSchema, reranker)).toEqual(reranker);
  });

  // Agents and `dot explain` read an options object's shape from its JSON Schema.
  it('every options schema answers a JSON Schema, a function field as any value', () => {
    const schemas: readonly StandardSchemaV1[] = [
      embedOptionsSchema,
      embedManyOptionsSchema,
      embedStreamOptionsSchema,
      embedderOptionsSchema,
      normalizeTextOptionsSchema,
      rerankCallOptionsSchema,
      rerankOptionsSchema,
      rerankCacheOptionsSchema,
      sparseEmbedOptionsSchema,
      sparseModelOptionsSchema,
      embeddingsPluginOptionsSchema,
      cohereModelOptionsSchema,
      cohereRerankerOptionsSchema,
      cohereCompatibleRerankerOptionsSchema,
      googleModelOptionsSchema,
      bedrockModelOptionsSchema,
      teiRerankerOptionsSchema,
      transformersModelOptionsSchema,
      transformersRerankerOptionsSchema,
      jinaModelOptionsSchema,
      jinaRerankerOptionsSchema,
      openaiCompatibleModelOptionsSchema,
      ollamaModelOptionsSchema,
      voyageModelOptionsSchema,
      voyageRerankerOptionsSchema,
      mistralModelOptionsSchema,
      openaiModelOptionsSchema,
    ];
    for (const schema of schemas) {
      expect(hasJsonSchema(schema)).toBe(true);
    }
    const json = cohereRerankerOptionsSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
    expect(json).toMatchObject({ type: 'object', required: ['apiKey'], properties: { fetch: {} } });
  });
});
