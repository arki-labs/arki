/**
 * Embedding runtime — ONE env reader for every app that embeds.
 *
 * Local-first (LAW 1): an explicit `EMBEDDING_PROVIDER` wins; otherwise Ollama
 * when `OLLAMA_BASE_URL` or `OLLAMA_HOST` is set; otherwise OpenAI when
 * `OPENAI_API_KEY` is set; otherwise `null`. `mock` is never a default — it is
 * only picked when named. Every value the provider needs (base URL, key,
 * model, dimensions) is read from the SAME `env` the selection read, so a
 * variable that selects a provider also reaches it.
 *
 * This module never touches `process.env`: `env` is a required argument. The
 * Dot entry (`@arki/ai/dot`) supplies the default thunk.
 */
import type { EmbeddingProvider } from '../types';
import type { EmbeddingProviderConfig, EmbeddingProviderType } from './factory';
import { debugEmbeddings } from '../debug.ts';
import { ConfigurationError } from '../errors';
import { createEmbeddingProviderAsync } from './factory';

/** A plain string map, e.g. `process.env` or a test fixture. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** What the env resolved to: which provider, which model, how many dimensions. */
export type EmbeddingSelection = {
  type: EmbeddingProviderType;
  /** Model id that produces the vectors — record it next to every stored vector. */
  model: string;
  /** Vector dimensionality — MUST equal the vector index's size. */
  dimensions: number;
};

/** Per-provider default model + dimensions, mirrored from each provider class, and the env var naming the model. */
const PROVIDER_DEFAULTS = {
  openai: { model: 'text-embedding-3-small', dimensions: 1536, modelVar: 'OPENAI_EMBEDDING_MODEL' },
  'openai-compatible': { model: '', dimensions: 0, modelVar: 'OPENAI_COMPATIBLE_MODEL' },
  cohere: { model: 'embed-v4.0', dimensions: 1536, modelVar: 'COHERE_EMBEDDING_MODEL' },
  mistral: { model: 'mistral-embed', dimensions: 1024, modelVar: 'MISTRAL_EMBEDDING_MODEL' },
  google: { model: 'gemini-embedding-001', dimensions: 3072, modelVar: 'GOOGLE_EMBEDDING_MODEL' },
  bedrock: { model: 'amazon.titan-embed-text-v2:0', dimensions: 1024, modelVar: 'BEDROCK_EMBEDDING_MODEL' },
  ollama: { model: 'qwen3-embedding:0.6b', dimensions: 1024, modelVar: 'OLLAMA_EMBEDDING_MODEL' },
  voyage: { model: 'voyage-3.5', dimensions: 1024, modelVar: 'VOYAGE_EMBEDDING_MODEL' },
  jina: { model: 'jina-embeddings-v3', dimensions: 1024, modelVar: 'JINA_EMBEDDING_MODEL' },
  nebius: { model: 'Qwen/Qwen3-Embedding-8B', dimensions: 4096, modelVar: 'NEBIUS_EMBEDDING_MODEL' },
  mixedbread: { model: 'mixedbread-ai/mxbai-embed-large-v1', dimensions: 1024, modelVar: 'MXBAI_EMBEDDING_MODEL' },
  'transformers-js': { model: 'nomic-ai/nomic-embed-text-v1.5', dimensions: 768, modelVar: 'TRANSFORMERS_JS_MODEL' },
  // Mock matches the Ollama dimension so mock vectors fit the production collection in e2e.
  mock: { model: 'mock-embedding', dimensions: 1024, modelVar: 'MOCK_EMBEDDING_MODEL' },
} satisfies Record<EmbeddingProviderType, { model: string; dimensions: number; modelVar: string }>;

const PROVIDER_TYPES = Object.keys(PROVIDER_DEFAULTS) as EmbeddingProviderType[];

function isProviderType(value: string): value is EmbeddingProviderType {
  return value in PROVIDER_DEFAULTS;
}

function numberFrom(env: EnvSource, key: string): number | undefined {
  const raw = env[key];
  return raw === undefined || raw === '' ? undefined : Number(raw);
}

function selectionFor(type: EmbeddingProviderType, env: EnvSource): EmbeddingSelection {
  const defaults = PROVIDER_DEFAULTS[type];
  const override = numberFrom(env, 'EMBEDDING_DIMENSIONS');
  if (type === 'openai-compatible') {
    const model = env['OPENAI_COMPATIBLE_MODEL'];
    const dimensions = override ?? numberFrom(env, 'OPENAI_COMPATIBLE_DIMENSIONS');
    if (!model || !dimensions) {
      throw new ConfigurationError(
        'openai-compatible embeddings need OPENAI_COMPATIBLE_MODEL and OPENAI_COMPATIBLE_DIMENSIONS (or EMBEDDING_DIMENSIONS).',
      );
    }
    return { type, model, dimensions };
  }
  const providerDimensions = type === 'nebius' ? numberFrom(env, 'NEBIUS_EMBEDDING_DIMENSIONS') : undefined;
  return {
    type,
    model: env[defaults.modelVar] ?? defaults.model,
    dimensions: override ?? providerDimensions ?? defaults.dimensions,
  };
}

/**
 * Pure resolution of the embedding selection from an env map.
 *
 * @returns the selection, or `null` when no provider is configured (callers
 *   degrade — they never fabricate vectors).
 * @throws ConfigurationError when `EMBEDDING_PROVIDER` names an unknown type.
 */
export function resolveEmbeddingSelection(env: EnvSource): EmbeddingSelection | null {
  const explicit = env['EMBEDDING_PROVIDER'];
  if (explicit) {
    if (!isProviderType(explicit)) {
      throw new ConfigurationError(
        `Unsupported EMBEDDING_PROVIDER "${explicit}". Supported: ${PROVIDER_TYPES.join(' | ')}.`,
      );
    }
    return selectionFor(explicit, env);
  }
  if (env['OLLAMA_BASE_URL'] || env['OLLAMA_HOST']) return selectionFor('ollama', env);
  if (env['OPENAI_API_KEY']) return selectionFor('openai', env);
  return null;
}

/** `{ apiKey }` when the var is set, `{}` otherwise — so a provider's own default still applies. */
function apiKeyFrom(env: EnvSource, key: string): { apiKey?: string } {
  const value = env[key];
  return value ? { apiKey: value } : {};
}

function baseURLFrom(env: EnvSource, key: string): { baseURL?: string } {
  const value = env[key];
  return value ? { baseURL: value } : {};
}

export type EmbeddingRuntime = { provider: EmbeddingProvider; selection: EmbeddingSelection };

/** The factory config for a selection, with every credential and URL read from the same `env`. */
function providerConfigFor(selection: EmbeddingSelection, env: EnvSource): EmbeddingProviderConfig {
  const { model, dimensions } = selection;
  switch (selection.type) {
    case 'openai': {
      return { type: 'openai', config: { model, dimensions, ...apiKeyFrom(env, 'OPENAI_API_KEY') } };
    }
    case 'openai-compatible': {
      const baseURL = env['OPENAI_COMPATIBLE_BASE_URL'];
      if (!baseURL) throw new ConfigurationError('openai-compatible embeddings need OPENAI_COMPATIBLE_BASE_URL.');
      return {
        type: 'openai-compatible',
        config: { model, dimensions, baseURL, ...apiKeyFrom(env, 'OPENAI_COMPATIBLE_API_KEY') },
      };
    }
    case 'cohere': {
      return { type: 'cohere', config: { model, dimensions, ...apiKeyFrom(env, 'COHERE_API_KEY') } };
    }
    case 'mistral': {
      return { type: 'mistral', config: { model, dimensions, ...apiKeyFrom(env, 'MISTRAL_API_KEY') } };
    }
    case 'google': {
      return { type: 'google', config: { model, dimensions, ...apiKeyFrom(env, 'GOOGLE_GENERATIVE_AI_API_KEY') } };
    }
    case 'bedrock': {
      return {
        type: 'bedrock',
        config: { model, dimensions, ...(env['AWS_REGION'] ? { region: env['AWS_REGION'] } : {}) },
      };
    }
    case 'ollama': {
      // The host var that selected Ollama must also reach it.
      return {
        type: 'ollama',
        config: { model, dimensions, ...baseURLFrom(env, env['OLLAMA_BASE_URL'] ? 'OLLAMA_BASE_URL' : 'OLLAMA_HOST') },
      };
    }
    case 'voyage': {
      return { type: 'voyage', config: { model, dimensions, ...apiKeyFrom(env, 'VOYAGE_API_KEY') } };
    }
    case 'jina': {
      return { type: 'jina', config: { model, dimensions, ...apiKeyFrom(env, 'JINA_API_KEY') } };
    }
    case 'nebius': {
      return {
        type: 'nebius',
        config: { model, dimensions, ...apiKeyFrom(env, 'NEBIUS_API_KEY'), ...baseURLFrom(env, 'NEBIUS_BASE_URL') },
      };
    }
    case 'mixedbread': {
      return { type: 'mixedbread', config: { model, dimensions, ...apiKeyFrom(env, 'MXBAI_API_KEY') } };
    }
    case 'transformers-js': {
      return { type: 'transformers-js', config: { model, dimensions } };
    }
    case 'mock': {
      return { type: 'mock', config: { dimensions } };
    }
  }
}

/**
 * Build the provider + its selection from `env`, or `null` when unconfigured.
 * Async because Bedrock lazy-imports its SDK (and Dot `provides` may be async).
 */
export async function createEmbeddingRuntime(env: EnvSource): Promise<EmbeddingRuntime | null> {
  const selection = resolveEmbeddingSelection(env);
  if (!selection) return null;
  debugEmbeddings.debug(
    '[Runtime] creating embedding provider (type: {type}, model: {model}, dims: {dimensions})',
    selection,
  );
  const provider = await createEmbeddingProviderAsync(providerConfigFor(selection, env));
  return { provider, selection };
}

// ── Qwen query-side instruction ──────────────────────────────
// Qwen3-Embedding is instruction-aware: query embeddings improve with an
// instruction prefix while document embeddings stay raw. Keyed on the MODEL
// name, not the provider type — Qwen runs on Ollama, Nebius, TEI, …
export const QWEN_QUERY_INSTRUCTION =
  'Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ';

function isQwenEmbeddingModel(model: string): boolean {
  return /qwen3-embedding/i.test(model);
}

/** Prefix the query instruction for Qwen models; return `text` unchanged otherwise. */
export function buildQueryText(text: string, selection: EmbeddingSelection): string {
  return isQwenEmbeddingModel(selection.model) ? `${QWEN_QUERY_INSTRUCTION}${text}` : text;
}

/**
 * Query-side embedder over a runtime (or none). `embedQuery` never throws on
 * the hot path: no runtime, a dimension mismatch against the caller's stored
 * vectors, or a provider failure all return `null` so the caller degrades
 * (e.g. answers without retrieval). The first observed output dimension is
 * remembered, so a known mismatch is skipped without another provider call.
 */
export function createEmbedder(runtime: EmbeddingRuntime | null) {
  let observedDimension: number | undefined;

  async function embedQuery(
    text: string,
    expectedDimensions?: number,
  ): Promise<{ vector: number[]; selection: EmbeddingSelection } | null> {
    if (!runtime) {
      debugEmbeddings.debug('[Embedder] no embedding provider configured — query not embedded');
      return null;
    }
    const { provider, selection } = runtime;

    if (
      expectedDimensions !== undefined &&
      observedDimension !== undefined &&
      observedDimension !== expectedDimensions
    ) {
      debugEmbeddings.debug('[Embedder] skipping — known dimension mismatch ({known} vs expected {expected})', {
        known: observedDimension,
        expected: expectedDimensions,
      });
      return null;
    }

    try {
      const vector = await provider.getEmbedding(buildQueryText(text, selection));
      observedDimension = vector.length;
      if (expectedDimensions !== undefined && vector.length !== expectedDimensions) {
        debugEmbeddings.debug('[Embedder] dimension mismatch: {model} produced {produced}, expected {expected}', {
          model: selection.model,
          produced: vector.length,
          expected: expectedDimensions,
        });
        return null;
      }
      return { vector, selection };
    } catch (error) {
      debugEmbeddings.debug('[Embedder] embedding call failed ({model}): {error}', {
        model: selection.model,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return { runtime, embedQuery };
}

export type Embedder = ReturnType<typeof createEmbedder>;
