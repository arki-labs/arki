# `@arki/ai/embeddings` — Provider Catalog

> This catalog is the integration-side companion to [STATE-OF-THE-ART.md](./STATE-OF-THE-ART.md). For each provider in the recommendation grid, this file documents which library backs it, how to import it, environment variables, and a one-liner of when to choose it.
>
> Updated 2026-05-17 alongside the embeddings extension that added 9 new providers and 6 rerankers.

## Quick map (recommendation grid → provider)

| Persona                    | Default provider                        | Module                              | Optional dep                |
| -------------------------- | --------------------------------------- | ----------------------------------- | --------------------------- |
| Local default (all volumes)| `ollama` (Qwen3-Embedding-0.6B)         | `OllamaEmbeddingProvider`           | —                           |
| Privacy-max (frontier)     | `ollama` (`qwen3-embedding:8b`)         | `OllamaEmbeddingProvider`           | —                           |
| Privacy-max (via TEI)      | `openai-compatible` (TEI on RTX 4090)   | `OpenAICompatibleEmbeddingProvider` | —                           |
| Cost-min low volume        | `openai` (text-embedding-3-small Batch) | `OpenAIEmbeddingProvider`           | —                           |
| Cost-min mid volume        | `bedrock` (Titan v2)                    | `createBedrockEmbeddingProvider`    | `@ai-sdk/amazon-bedrock`    |
| Balanced                   | `voyage` (`voyage-4` w/ 200M free tier) | `VoyageEmbeddingProvider`           | `voyageai`                  |
| Balanced (long ctx)        | `cohere` (`embed-v4` 128K ctx)          | `CohereEmbeddingProvider`           | —                           |
| Balanced (EU)              | `mistral` (`mistral-embed`)             | `MistralEmbeddingProvider`          | —                           |
| Cloud quality leader       | `google` (`gemini-embedding-001`)       | `GoogleEmbeddingProvider`           | —                           |
| Latency-critical (rerank)  | `cohere` reranker → `tei` reranker      | `CohereReranker` / `TeiReranker`    | —                           |
| On-device                  | `transformers-js` (Nomic-Embed-v1.5)    | `TransformersJsEmbeddingProvider`   | `@huggingface/transformers` |

## Embedding providers

### `openai`

- **Library:** raw `fetch` to OpenAI `/v1/embeddings` (existing, predates AI SDK)
- **Default model:** `text-embedding-3-small` (1536-d, 8K ctx, $0.02/M)
- **Env:** `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL`
- **When:** the simplest cloud default; below 100M tok/mo OpenAI Batch ($0.01/M) is hard to beat on simplicity.

### `openai-compatible`

- **Library:** `@ai-sdk/openai` with `createOpenAI({ baseURL })`
- **Covers:** Hugging Face TEI, vLLM ≥0.19, SGLang ≥0.5.10, Groq, Anyscale, Together (for OSS), or any custom OpenAI-API-compatible shim.
- **Required config:** `baseURL`, `model`, `dimensions`
- **Env:** `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL`, `OPENAI_COMPATIBLE_DIMENSIONS`, `OPENAI_COMPATIBLE_API_KEY` (optional)
- **When:** self-hosting frontier OSS models (Qwen3-Embedding-8B, Stella-1.5B, BGE-M3) on your own GPU. Reuses the OpenAI SDK so caching/batching are shared.

### `cohere`

- **Library:** `@ai-sdk/cohere` (added in this extension)
- **Default model:** `embed-v4.0` (1536-d MRL, 128K ctx — longest of any 2026 model)
- **Env:** `COHERE_API_KEY`, `COHERE_EMBEDDING_MODEL`
- **When:** long-document RAG, multilingual, or whenever the 128K context helps.

### `mistral`

- **Library:** `@ai-sdk/mistral` (already in deps)
- **Default model:** `mistral-embed` (1024-d, 8K ctx, France-jurisdiction)
- **Env:** `MISTRAL_API_KEY`, `MISTRAL_EMBEDDING_MODEL`
- **When:** EU-native residency without going to Azure regions. For code use `codestral-embed-2505`.

### `google`

- **Library:** `@ai-sdk/google` (already in deps)
- **Default model:** `gemini-embedding-001` (3072-d MRL, 2K ctx, MMTEB 68.32 — cloud-API leader)
- **Env:** `GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_EMBEDDING_MODEL`
- **When:** maximum cloud-API quality; mind the 2K context cap.

### `bedrock` (async-only)

- **Library:** `@ai-sdk/amazon-bedrock` (optional peer, lazy-imported)
- **Default model:** `amazon.titan-embed-text-v2:0` (1024-d MRL → 256, $0.02/M)
- **Env:** `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BEDROCK_EMBEDDING_MODEL`
- **When:** existing AWS shop with FedRAMP/HIPAA requirements; Titan v2 is cost-tier $0.02/M.
- **Usage:** `await createBedrockEmbeddingProvider({...})` — not in the sync factory because the SDK is heavy.

### `ollama`

- **Library:** `ai-sdk-ollama` (already in deps, AI SDK v6 native)
- **Default model:** `qwen3-embedding:0.6b` (600M, 1024-d, 32K ctx, Apache 2.0, MTEB-Eng ~65 / MMTEB ~64). Fits in ~1.2 GB VRAM fp16 / ~600 MB int8, marginal on CPU.
- **Env:** `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`), `OLLAMA_EMBEDDING_MODEL`
- **Trade up to bigger Qwen3 for better quality:**
  - `qwen3-embedding:4b`  — ~8 GB VRAM fp16, 2560-d MRL, MTEB-Eng ~68 / MMTEB ~69
  - `qwen3-embedding:8b`  — ~16 GB VRAM fp16, 4096-d MRL, **MMTEB 70.58 / MTEB-Code 80.68 (open-weights leader)**
- **Alternative smaller models:** `nomic-embed-text` (137M, 768-d), `snowflake-arctic-embed2`, `mxbai-embed-large`, `bge-m3`
- **When:** local-first development, or production self-host with `OLLAMA_BASE_URL` pointing at your remote Ollama server. Per workspace operating rule, Ollama is the preferred default.

  **Note:** `ai-sdk-ollama` appends `/api/<route>` internally — `OLLAMA_BASE_URL` must be the bare host (e.g. `http://127.0.0.1:11434`), not `.../api`.

### `voyage`

- **Library:** `voyageai` (optional peer, lazy-imported)
- **Default model:** `voyage-3.5` (1024-d, 32K ctx)
- **Env:** `VOYAGE_API_KEY`, `VOYAGE_EMBEDDING_MODEL`
- **Notable:** 200M tokens/mo free tier; v3-large ↔ v4-large claim shared embedding space (S-03, unverified per G-14).
- **When:** balanced production; free tier covers ~3 years at 100M tok/yr.

### `jina`

- **Library:** raw `fetch` to `api.jina.ai/v1/embeddings` (no official JS SDK)
- **Default model:** `jina-embeddings-v3` (570M, 1024-d MRL, 8K ctx)
- **Env:** `JINA_API_KEY`, `JINA_EMBEDDING_MODEL`
- **Special:** supports `lateChunking: true` for long-doc retrieval (Jina v3-only feature; +1–3 NDCG@10 on LongEmbed). Jina v3/v4 open weights are CC-BY-NC — commercial use requires the hosted API.

### `mixedbread`

- **Library:** `@mixedbread-ai/sdk` (optional peer, lazy-imported)
- **Default model:** `mixedbread-ai/mxbai-embed-large-v1` (335M, Apache 2.0, binary MRL native)
- **Env:** `MXBAI_API_KEY` (or `MIXEDBREAD_API_KEY`), `MXBAI_EMBEDDING_MODEL`
- **When:** binary-quantization-first workloads. Use paid tier in production — free tier may use submitted data for training.

### `transformers-js` (on-device)

- **Library:** `@huggingface/transformers` v4+ (optional peer, lazy-imported; ONNX/WebGPU runtime, ~4× WASM speed)
- **Default model:** `nomic-ai/nomic-embed-text-v1.5` (137M, 768-d MRL, 8K ctx)
- **Env:** `TRANSFORMERS_JS_MODEL`
- **Quantization options:** `fp32`, `fp16`, `q8` (default), `q4`
- **Device options:** `auto`, `cpu`, `gpu`, `webgpu`, `wasm`
- **When:** Persona 5 — fully local in browser, Node, Electron, mobile. $0 infra; ~50–200 ms per query on modern devices.

### `mock`

- **Library:** none (deterministic hash-based)
- **When:** unit tests and offline development.

## Rerankers

Importable from `@arki/ai/embeddings/rerankers`.

### `cohere` (rerank)

- **Library:** `@ai-sdk/cohere` (uses AI SDK v6 native `rerank()`)
- **Default model:** `rerank-v3.5` (multilingual, +15–20% NDCG@10 lift)
- **Env:** `COHERE_API_KEY`, `COHERE_RERANK_MODEL`
- **Cost:** $2.00 per 1k searches. Above ~1M queries/mo, switch to `tei` reranker.

### `voyage` (rerank)

- **Library:** `voyageai` (lazy)
- **Default model:** `rerank-2.5` (32K ctx, instruction-following)
- **Env:** `VOYAGE_API_KEY`, `VOYAGE_RERANK_MODEL`

### `jina` (rerank)

- **Library:** raw fetch
- **Default model:** `jina-reranker-v2-base-multilingual` (278M, 100+ langs)
- **Env:** `JINA_API_KEY`, `JINA_RERANK_MODEL`

### `tei` (rerank)

- **Library:** raw fetch to TEI `/rerank`
- **Required config:** `baseURL`
- **Covers:** `mxbai-rerank-large-v2`, `BAAI/bge-reranker-v2-m3`, `BAAI/bge-reranker-v2-gemma`, `Qwen/Qwen3-Reranker-{0.6,4,8}B`
- **Cost economics:** self-host on 2× A10G HA ≈ $700/mo for 10M queries/mo (vs Cohere's $20k/mo at the same volume per SOTA B-01-22).

### `mixedbread` (rerank)

- **Library:** `@mixedbread-ai/sdk` (lazy)
- **Default model:** `mixedbread-ai/mxbai-rerank-large-v1`
- **Env:** `MXBAI_API_KEY`, `MXBAI_RERANK_MODEL`

### `bedrock` (rerank)

- **Library:** `@ai-sdk/amazon-bedrock` (lazy)
- **Default model:** `cohere.rerank-v3-5:0`
- **Env:** AWS chain + `BEDROCK_RERANK_MODEL`

## Usage examples

### Synchronous factory (env-driven)

```ts
import { createEmbeddingProviderFromEnv } from '@arki/ai/embeddings';

// EMBEDDING_PROVIDER=cohere COHERE_API_KEY=...
const embedder = createEmbeddingProviderFromEnv();
const vec = await embedder.getEmbedding('hello world');
```

### Synchronous factory (explicit config)

```ts
import { createEmbeddingProvider } from '@arki/ai/embeddings';

const embedder = createEmbeddingProvider({
  type: 'voyage',
  config: { model: 'voyage-4-large', inputType: 'document' },
});
```

### Bedrock (async factory)

```ts
import { createEmbeddingProviderAsync } from '@arki/ai/embeddings';

const embedder = await createEmbeddingProviderAsync({
  type: 'bedrock',
  config: { model: 'amazon.titan-embed-text-v2:0', dimensions: 256 },
});
```

### OpenAI-compatible (self-host TEI / vLLM)

```ts
import { OpenAICompatibleEmbeddingProvider } from '@arki/ai/embeddings';

const embedder = new OpenAICompatibleEmbeddingProvider({
  baseURL: 'http://tei.internal:8080/v1',
  model: 'Qwen/Qwen3-Embedding-8B',
  dimensions: 4096,
  label: 'tei-qwen3-8b',
});
```

### On-device (Persona 5)

```ts
import { TransformersJsEmbeddingProvider } from '@arki/ai/embeddings';

const embedder = new TransformersJsEmbeddingProvider({
  model: 'nomic-ai/nomic-embed-text-v1.5',
  dtype: 'q8',
  device: 'webgpu',
});
```

### Rerankers

```ts
import { createReranker } from '@arki/ai/embeddings/rerankers';

// Cloud default
const cloud = createReranker({ type: 'cohere' });

// High-volume self-host alternative
const local = createReranker({
  type: 'tei',
  config: {
    baseURL: 'http://tei-rerank.internal:8080',
    model: 'mxbai-rerank-large-v2',
  },
});

const ranked = await cloud.rerank('what is RAG?', candidateDocs, { topK: 5 });
```

### Stacking embed + rerank (Persona 3 / 4 pattern)

```ts
import { createEmbeddingProvider } from '@arki/ai/embeddings';
import { createReranker } from '@arki/ai/embeddings/rerankers';

const embedder = createEmbeddingProvider({ type: 'voyage' });
const reranker = createReranker({ type: 'cohere' });

const queryVec = await embedder.getEmbedding(query);
const candidates = await vectorSearch(queryVec, { topK: 50 });
const reranked = await reranker.rerank(
  query,
  candidates.map(c => c.text),
  {
    topK: 5,
    returnDocuments: true,
  },
);
```

## Custom providers

Apps that need a provider not in this catalog can extend `BaseEmbeddingProvider`:

```ts
import { BaseEmbeddingProvider } from '@arki/ai/embeddings';

class MyProvider extends BaseEmbeddingProvider {
  protected providerLabel = 'my-provider';
  getDimensions() {
    return 1024;
  }
  protected async fetchEmbeddings(texts: string[]): Promise<number[][]> {
    // hit your endpoint; return [[...], [...]]
  }
}
```

Or wrap any Vercel AI SDK embedding model with `AiSdkEmbeddingProvider`:

```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import { AiSdkEmbeddingProvider } from '@arki/ai/embeddings';

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });
const embedder = new AiSdkEmbeddingProvider({
  model: openrouter.embedding('BAAI/bge-m3'),
  dimensions: 1024,
  label: 'openrouter-bge-m3',
});
```

## What's not included

Per the deep-research-digest findings, the following candidates were considered but skipped:

- **MLX on Node** (Persona 5 alt) — Node bindings (`node-mlx`, `mlx-node`) are immature. For MLX-backed inference, run `vllm-mlx` as a server and connect via `openai-compatible`.
- **`fastembed` NPM package** — overlaps with `transformers-js`; if you need it, extend `BaseEmbeddingProvider` directly (small surface area).
- **`@xenova/transformers` v2** — superseded by `@huggingface/transformers` v4 which we ship instead.
- **Custom Jina open-weights self-host** — license is CC-BY-NC (non-commercial). Use the hosted Jina API or pick a different OSS model.

## Versioning notes

- AI SDK v6's `rerank()` allow-list currently covers **Cohere**, **Bedrock**, and **Together.ai** only. For Voyage / Jina / Mixedbread / TEI rerankers, we call provider SDKs / raw HTTP directly — the unified `Reranker` interface keeps the API stable regardless.
- `voyageai` v0.2+, `@mixedbread-ai/sdk` v1+, `@huggingface/transformers` v4+ are the targeted versions. They are declared as **optional peer dependencies** — apps install them only if they use the corresponding provider.

## See also

- [STATE-OF-THE-ART.md](./STATE-OF-THE-ART.md) — the research synthesis that drove this catalog
- [research/findings.md](./research/findings.md) — evidence-backed findings with stable IDs
- [research/next-research.md](./research/next-research.md) — prioritized follow-up roadmap (Romanian per-language MTEB, vector-DB benchmarks, measured throughput, Voyage v3↔v4 compat)
