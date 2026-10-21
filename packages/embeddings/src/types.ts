import type { getLogger } from '@arki/log';

import type { EmbedFailure } from './failures.js';

/** Every provider this package can build a model record for. `fake` is the deterministic test embedder. */
export const EMBEDDING_PROVIDERS = [
  'ollama',
  'openai',
  'voyage',
  'google',
  'cohere',
  'mistral',
  'jina',
  'bedrock',
  'transformers',
  'openai-compatible',
  'fake',
] as const;
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];

/** `provider:model`, e.g. `'ollama:qwen3-embedding:0.6b'`. Everything after the first `:` is the model id. */
export type EmbeddingModelRef = `${EmbeddingProviderName}:${string}`;

/** Why a text is embedded. Asymmetric models prefix queries and documents differently. */
export const PURPOSES = ['query', 'document', 'similarity', 'classification', 'clustering'] as const;
export type Purpose = (typeof PURPOSES)[number];

/** Prefix per purpose; `''` or absent = no prefix. `version` goes into the space id, so changing a prompt is a new space. */
export type Instruction = Readonly<Partial<Record<Purpose, string>>> & { readonly version: number };

/** One input. A string is text; the object form carries an image for multimodal models. */
export type EmbedInput = string | { readonly text?: string; readonly image?: Uint8Array; readonly mimeType?: string };

/** How a token count was obtained, weakest last: `reported` by the provider, `counted` by a tokenizer, `estimated` from characters. */
export type TokenCount =
  | { readonly basis: 'reported' | 'counted' | 'estimated'; readonly count: number }
  | { readonly basis: 'unknown' };

/** What a call cost. `requests` counts native provider calls; `loadMs` is model load time when the provider reports it. */
export type Usage = {
  readonly tokens: TokenCount;
  readonly requests: number;
  readonly cacheHits: number;
  readonly loadMs?: number;
};

/** The output dtype of a vector. `float32` is every provider's default. */
export const QUANTIZATIONS = ['float32', 'int8', 'binary'] as const;
export type Quantization = (typeof QUANTIZATIONS)[number];

/**
 * Everything that must match for two vectors to be comparable. Stored next to every index
 * (as {@link spaceId}); a different space means re-embed, never mix.
 */
export type EmbeddingSpace = {
  readonly provider: EmbeddingProviderName;
  readonly model: string;
  readonly revision?: string;
  readonly dimensions: number;
  readonly normalized: boolean;
  readonly quantization: Quantization;
  /** Fingerprint of the {@link Int8Calibration} for int8 made by this package; absent for provider-native int8. */
  readonly calibration?: string;
  readonly instructionVersion: number;
};

/**
 * The value range per dimension that client-side int8 maps onto -128…127. One calibration is shared
 * by a whole corpus: vectors scaled with different ranges are not comparable.
 */
export type Int8Calibration = { readonly min: Float32Array; readonly max: Float32Array };

/** What a model record's native call answers: one raw vector per text, unchecked, plus what the provider said it cost. */
export type NativeEmbeddings = {
  readonly vectors: readonly ArrayLike<unknown>[];
  readonly tokens: TokenCount;
  readonly loadMs?: number;
};

/** What `createEmbedder` asks a model record for: prepared texts (instruction already applied) and output options. */
export type NativeRequest = {
  readonly texts: readonly string[];
  /**
   * The call's purpose, for providers that take it as a field (Voyage `input_type`, Cohere
   * `input_type`, Google `taskType`). Its prefix, if the model has one, is already in `texts`.
   */
  readonly purpose?: Purpose;
  /** Set only when it differs from the model's native size. */
  readonly dimensions?: number;
  /** Set only for a provider-native dtype listed in `model.quantizations`. */
  readonly quantization?: 'int8' | 'binary';
  /** Set only for `onTooLong: 'truncate'`: cut each text to what the model accepts instead of refusing it. */
  readonly truncate?: true;
  readonly signal?: AbortSignal;
};

/**
 * Facts about one model plus the one native call that reaches it. The provider client lives inside
 * `embedTexts` (a closure), never in the type, so the root names no provider SDK.
 */
export type EmbeddingModel = {
  readonly provider: EmbeddingProviderName;
  readonly id: string;
  /** Ollama digest, HF commit, provider snapshot. Ollama learns it on the first call. */
  readonly revision?: string;
  /** Learns a lazy `revision` without embedding (Ollama). Absent when the revision is known up front or never. */
  loadRevision?(signal?: AbortSignal): Promise<EmbedFailure | undefined>;
  readonly assurance: 'immutable' | 'operator-pinned' | 'mutable';
  readonly local: boolean;
  /** Native output size. */
  readonly dimensions: number;
  /** Allowed truncations; `[]` if none. */
  readonly matryoshka: readonly number[];
  readonly maxInputTokens: number;
  /** Inputs per request. */
  readonly maxBatch: number;
  /** Tokens per request. */
  readonly maxBatchTokens: number;
  readonly normalized: boolean;
  readonly instruction: Instruction;
  readonly inputs: readonly ('text' | 'image')[];
  /** Provider-native output dtypes. */
  readonly quantizations: readonly ('int8' | 'binary')[];
  /** Exact tokens of one text, when the record carries a tokenizer. Without it, `countTokens` estimates. */
  readonly countTokens?: (text: string) => number;
  /** One native request, at most `maxBatch` texts, no retry. Output is validated by `createEmbedder`, not here. */
  readonly embedTexts: (request: NativeRequest) => Promise<NativeEmbeddings | EmbedFailure>;
  /** Frees an in-process session (Transformers.js). */
  dispose?(): Promise<void>;
};

/** Per-call options. `dimensions` and `quantization` override the embedder's defaults for this call. */
export type EmbedOptions = {
  readonly purpose?: Purpose;
  readonly dimensions?: number;
  readonly quantization?: 'int8' | 'binary';
  /**
   * An input longer than `model.maxInputTokens`: `'fail'` (default) returns `InputTooLong` before
   * any request; `'truncate'` lets the provider cut it (Ollama) or cuts it at `maxInputTokens * 4`
   * characters first (OpenAI, OpenAI-compatible).
   */
  readonly onTooLong?: 'fail' | 'truncate';
  readonly signal?: AbortSignal;
};

export type Embedding = {
  readonly vector: Float32Array | Int8Array | Uint8Array;
  readonly space: EmbeddingSpace;
  readonly usage: Usage;
};

export type EmbeddingBatch = {
  readonly vectors: readonly Embedding['vector'][];
  readonly space: EmbeddingSpace;
  readonly usage: Usage;
};

/** A model with its output options fixed. `embed` is one native attempt of at most `model.maxBatch` inputs. */
export type Embedder = {
  readonly model: EmbeddingModel;
  /** At the embedder's default dimensions and quantization; carries the revision once the model knows it. */
  readonly space: EmbeddingSpace;
  /** The space a call with these options answers in, e.g. for a cache key before the call. */
  spaceFor(options: Pick<EmbedOptions, 'dimensions' | 'quantization'>): EmbeddingSpace;
  embed(inputs: readonly EmbedInput[], options: EmbedOptions): Promise<EmbeddingBatch | EmbedFailure>;
};

/** Wraps an embedder's `embed`. `withMiddleware` composes them, the first outermost. */
export type EmbedMiddleware = (next: Embedder['embed'], embedder: Embedder) => Embedder['embed'];

/** Byte store behind `withCache`: `memoryCacheStore()` in process, `kvCacheStore(kv)` from `@arki/embeddings/kv` through Redis. */
export type CacheStore = {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array, ttlMs?: number): Promise<void>;
};

/** Where `resolveEmbeddingModel` reads variables from: `process.env`, `import.meta.env`, or a plain record. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** The logger `createEmbedder` writes lifecycle records to. `@arki/log` exports no `Logger` name. */
export type EmbeddingsLogger = ReturnType<typeof getLogger>;
