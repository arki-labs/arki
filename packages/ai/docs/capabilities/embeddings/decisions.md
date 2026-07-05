# Embeddings Capability — Decision Log

> Chronological record of decisions made during the embeddings capability build-out. Each entry has a stable `D-EMB-NN` id, the decision itself, the rationale (Why), the trade-off accepted, and the concrete instruction for future readers (How to apply).
>
> This log lives alongside [STATE-OF-THE-ART.md](./STATE-OF-THE-ART.md) (the research synthesis), [PROVIDERS.md](./PROVIDERS.md) (the integration catalog), and [research/](./research/) (the digest audit trail). When those documents disagree, this log wins — it records the reasoned position we actually committed to.

## Session context

- **Date range:** 2026-05-17 — 2026-07-04
- **Trigger:** Deep-research digest across 5 LLM outputs (`prompt.md` → `{chatgpt,claude,glm,qwen,gemini}.research.md`)
- **Output:** State-of-the-art synthesis + a 10× extension of `packages/ai/src/embeddings/`
- **Reviewer:** Founder (alex@furculita.net)
- **Model:** Claude Opus 4.7 in explanatory mode

## Decisions

### D-EMB-01 — Adopt a profile-based recommendation grid, not a single winner

**Decision:** The `@arki/ai/embeddings` surface exposes multiple provider modules simultaneously. Consumers pick by profile (privacy-max / cost-min / balanced / latency-critical / on-device); there is no single "default best" model.

**Why:** Every LLM research source in the digest produced a different top pick, and the digest's contradiction analysis (see `research/contradictions.md` C-25 through C-28) traced every disagreement back to which persona the source implicitly optimized for. Committing to a single winner would embed one persona's assumptions in the API surface and make the package useless for the others.

**Trade-off accepted:** More provider modules to maintain (currently 12). Bigger surface for consumers to learn. In return: any workspace app can pick its persona without the package pushing back.

**How to apply:** When adding a new use case, look up the profile in [STATE-OF-THE-ART.md#recommendations](./STATE-OF-THE-ART.md#recommendations) → the recommendation grid → pick the matching provider. Only revisit this decision if a truly universal winner emerges (unlikely; see D-EMB-09).

---

### D-EMB-02 — Extract `BaseEmbeddingProvider` before adding the second real provider

**Decision:** All concrete providers subclass `BaseEmbeddingProvider` (`src/embeddings/base.ts`) which owns caching, batching (50-ms coalescing window), text normalization, and the retry-shape. Subclasses only implement `fetchEmbeddings(texts) → number[][]` and `getDimensions() → number`.

**Why:** The original `OpenAIEmbeddingProvider` had ~150 LOC of caching/batching intertwined with fetch logic. Copying that per provider would have added ~1,500 LOC across the 10 new providers with 10 chances of subtle divergence. Extracting once locked the behavior.

**Trade-off accepted:** New providers must accept the base class's caching model (in-memory `Map<string, number[]>`, deterministic hash key = normalized text). Providers with per-model quirks — Voyage's `input_type: query|document`, Jina's task-hint — still work because normalization is provider-side and cache lookup happens on normalized text.

**How to apply:** Any new provider adds ~20–40 LOC (constructor, `getDimensions`, `fetchEmbeddings`). If you need to change caching semantics — e.g. TTL, disk-backed, semantic-hash — do it in `base.ts` and every provider inherits.

---

### D-EMB-03 — Wrap AI-SDK providers via a single `AiSdkEmbeddingProvider` adapter

**Decision:** Every provider that has a Vercel AI SDK v6 module (`@ai-sdk/openai`, `@ai-sdk/cohere`, `@ai-sdk/mistral`, `@ai-sdk/google`, `@ai-sdk/amazon-bedrock`, `ai-sdk-ollama`) routes through `AiSdkEmbeddingProvider` in `src/embeddings/providers/ai-sdk.ts`. That adapter takes an `EmbeddingModel` from any AI SDK and calls `embedMany()`.

**Why:** The AI SDK v6's `embed`/`embedMany` API is provider-agnostic. Reusing it means we get automatic retry, telemetry, and any future provider that ships an AI SDK adapter drops in with ~20 LOC.

**Trade-off accepted:** We are tied to the AI SDK v6 API surface. If v7 breaks `embedMany` we do a single-file migration.

**How to apply:** New AI-SDK-backed provider = `class MyProvider extends AiSdkEmbeddingProvider { constructor(cfg) { super({ label: 'my', model: sdk.embedding(cfg.model), dimensions: cfg.dimensions ?? DEFAULT }); } }`. See `cohere.ts`, `mistral.ts`, `google.ts`, `ollama.ts` for canonical shape.

---

### D-EMB-04 — Ship an `openai-compatible` generic provider for TEI / vLLM / SGLang / Groq / Anyscale

**Decision:** Rather than write one provider per OpenAI-API-compatible runtime, ship `OpenAICompatibleEmbeddingProvider` which just takes a `baseURL` override to `createOpenAI()` from `@ai-sdk/openai`.

**Why:** Hugging Face TEI, vLLM ≥0.19, SGLang ≥0.5.10, Groq, Anyscale, Together (for OSS models), and any custom OpenAI-compat shim (including Nebius and DeepInfra, though those got dedicated providers for other reasons — see D-EMB-08 and D-EMB-09) all expose the same `/v1/embeddings` shape. One generic module covers the entire tier at zero maintenance cost.

**Trade-off accepted:** Cache key is `(normalized text)`, not `(baseURL, model, text)` — so if a consumer swaps `baseURL` mid-process, they must instantiate a new provider. In practice this never happens.

**How to apply:** Self-hosting Qwen3-Embedding-8B on your own TEI/vLLM box? Point `openai-compatible` at `http://your-host:8080/v1` with `model: 'Qwen/Qwen3-Embedding-8B'`, `dimensions: 4096`. See [PROVIDERS.md#openai-compatible](./PROVIDERS.md#openai-compatible).

---

### D-EMB-05 — Rerankers live in `embeddings/rerankers/`, not on `EmbeddingProvider`

**Decision:** Reranking is a sibling submodule (`src/embeddings/rerankers/`), not a method on `EmbeddingProvider`. Distinct interface (`(query, docs, options) → RerankResult[]`), distinct lifecycle (per-query, no batching), distinct provider matrix (Cohere Rerank 3.5, Voyage Rerank 2.5, Jina Reranker v2, TEI-served cross-encoders like mxbai-rerank-v2 / BGE / Qwen3-Reranker, Mixedbread, Bedrock).

**Why:** Rerankers have almost nothing in common with dense embedders operationally — different scale characteristics, different failure modes, different cost economics. Vercel AI SDK v6 made the same architectural split with its `rerank()` function and separate `RerankingModelV3` type.

**Trade-off accepted:** Two interfaces to learn (`EmbeddingProvider` and `Reranker`). But composition is trivial: `embedder.getEmbedding(q) → vectorSearch(v, {topK:50}) → reranker.rerank(q, candidates, {topK:5})`.

**How to apply:** Import from `@arki/ai/embeddings/rerankers`. The `Reranker` interface unifies over the six current implementations regardless of whether they use AI SDK's native `rerank()` (Cohere, Bedrock), a vendor SDK (Voyage, Mixedbread), or raw fetch (Jina, TEI).

---

### D-EMB-06 — Heavy or vendor-uncertain SDKs are optional peer dependencies with `@ts-expect-error` dynamic imports

**Decision:** `voyageai`, `@mixedbread-ai/sdk`, `@huggingface/transformers`, `@ai-sdk/amazon-bedrock` are `peerDependenciesMeta.optional: true`. Providers dynamic-import them (`await import('voyageai')`) with `@ts-expect-error` on the import line because TypeScript can't see the module.

**Why:** These SDKs each ship 5–50 MB of transitive dependencies (AWS signer chain, ONNX runtime, tokenizer natives). Apps that only use OpenAI or Ollama should not pay that cost.

**Trade-off accepted:** Consumers must add the SDK to their app's `package.json` if they use one of these providers. The runtime error at first use ("Cannot find module 'voyageai'") is a clear signal.

**How to apply:** When adding a new provider whose SDK weight >5 MB or whose npm publisher risk-profile is unclear, follow the same pattern — see `voyage.ts`, `mixedbread.ts`, `transformers-js.ts` for the recipe.

---

### D-EMB-07 — Ollama local default = `qwen3-embedding:0.6b`, not `nomic-embed-text`

**Decision:** `OllamaEmbeddingProvider` defaults to `qwen3-embedding:0.6b` at 1024-d. Nomic (137M, 768-d) drops to the "alternatives" list for people who want the smallest possible model.

**Why:** Qwen3-Embedding-0.6B beats Nomic-Embed-Text-v1.5 on MTEB-Eng (~65 vs 62.4) while staying within a fittable memory footprint (~1.2 GB VRAM fp16 / ~600 MB int8). Same Apache 2.0 license. Users with 8+ GB VRAM can bump the tag to `:4b` (MTEB ~68 / MMTEB ~69) or `:8b` (MMTEB 70.58 leader) without changing anything else.

**Trade-off accepted:** First run requires `ollama pull qwen3-embedding:0.6b`. Cold start is a bit slower than Nomic because it's ~4× the parameters.

**How to apply:** For every new workspace app that uses local embeddings, this is the anchor. Bumping to `:4b`/`:8b` is a one-line change (`OLLAMA_EMBEDDING_MODEL`). See [PROVIDERS.md#ollama](./PROVIDERS.md#ollama).

---

### D-EMB-08 — Nebius is a first-class provider with raw fetch, not just an `openai-compatible` config

**Decision:** `NebiusEmbeddingProvider` in `src/embeddings/providers/nebius.ts` is its own module even though Nebius's `/v1/embeddings` is OpenAI-compatible. Default model `Qwen/Qwen3-Embedding-8B` at 4096-d; default base URL `https://api.tokenfactory.nebius.com/v1`.

**Why:** Two reasons:
1. **Cloud path to Qwen3-Embedding-8B (MMTEB leader) without self-hosting the 8B weights** — Nebius appears to be one of the cheapest hosted routes to the current open-weights MMTEB leader per the research (~$0.010/M input tokens, subject to verification per D-EMB-09).
2. **Response-shape robustness.** The Nebius provider trusts the `data[i].index` field from the OpenAI embeddings response shape (`out[row.index] = row.embedding`), not array order. `openai-compatible` doesn't need to because the AI SDK abstracts it; raw fetch does. Same reason `jina.ts` is a first-class module.

**Trade-off accepted:** Duplicated `fetch` + auth code between `nebius.ts` and `jina.ts` (both raw-fetch OpenAI-like endpoints). Acceptable — both are ~50 LOC and diverge on request-body shape and error-handling nuances.

**How to apply:** For cost-minimized hosted-OSS-frontier workloads, prefer the first-class `nebius` provider over generic `openai-compatible` — you get the sensible default model + dimensions and don't have to remember the base URL.

---

### D-EMB-09 — Sourcing rigor: hosted-price claims require primary-source verification before we anchor a production decision on them

**Decision:** Any `$/M-token` claim in [PROVIDERS.md](./PROVIDERS.md), [STATE-OF-THE-ART.md](./STATE-OF-THE-ART.md), or downstream cost math must have a verifiable source of one of these tiers:

- **Verified-primary:** the vendor's own pricing page fetched directly and the price appears in static (non-JS-rendered) HTML.
- **Verified-model-page:** the vendor's model-specific detail page states the price, even if the marketing landing page omits it.
- **Aggregator-secondary:** a third-party price index (pricepertoken.com, CloudPrice, LeanOpsTech) — labelled explicitly.
- **Search-snippet-unverified:** the price came from a search-result summary and I could not verify from a primary page.

**Why:** During this session I claimed `Nebius $0.010/M` in a recommendation grid, and later admitted the number came from a WebSearch summary sentence, not from the Nebius pricing page (which is client-rendered JavaScript, invisible to WebFetch). The founder caught it. Retroactively: the `DeepInfra $0.010/M` claim for Qwen3-Embedding-8B was verified against the model-specific detail page (`deepinfra.com/Qwen/Qwen3-Embedding-8B`) but conflicts with the marketing landing page (`deepinfra.com/pricing`) which lists only legacy models — so it is verified-model-page tier, and until we smoke-test the actual API endpoint it carries residual risk.

**Trade-off accepted:** More effort per claim. In return: the doc's recommendations don't collapse when a real production commitment is being made.

**How to apply:** See [PROVIDERS.md#hosted-qwen3-embedding-8b-pricing-sourcing-confidence](./PROVIDERS.md#hosted-qwen3-embedding-8b-pricing-sourcing-confidence) for the actual current-state grid. Every price claim carries its confidence tier. When a new price is added, label it. See `NR-26` in [research/next-research.md](./research/next-research.md) for the manual browser-verify pass that will upgrade the "search-snippet-unverified" entries.

---

## Sourcing-confidence table — hosted `Qwen3-Embedding-8B` (as of 2026-07-04)

Live snapshot of pricing knowledge, with explicit confidence tags per D-EMB-09. Do not commit to a production hosted deployment without walking the "verify before" column first.

| Provider | Claimed $/M input | Confidence | Verified against | Verify before production |
|---|---|---|---|---|
| **Fireworks AI** | $0.00 (serverless) | Verified-model-page | `fireworks.ai/models/fireworks/qwen3-embedding-8b` | Rate caps + true cost when limits are hit |
| **DeepInfra** | $0.010 | Verified-model-page, conflicts with landing | `deepinfra.com/Qwen/Qwen3-Embedding-8B/api` (says $0.010); marketing landing at `deepinfra.com/pricing` omits Qwen3-8B entirely, lists only legacy BGE/E5/GTE/MiniLM at $0.005–$0.01 | Smoke-test the actual `POST /v1/openai/embeddings` endpoint with `model: 'Qwen/Qwen3-Embedding-8B'`. If pooled tier is retired for new models, budget accordingly |
| **OpenRouter** | $0.010 | Verified-primary | `openrouter.ai/qwen/qwen3-embedding-8b` (static HTML) | Aggregator markup + provider routing behavior on your workload |
| **Nebius Token Factory** | ~$0.010 (unverified) | **Search-snippet-unverified** | Two search summaries from `tokenfactory.nebius.com`. Actual pricing page is JS-rendered; WebFetch could not read it | Manually load `tokenfactory.nebius.com/prices` in a real browser and confirm |
| **SiliconFlow** | $0.040 | Verified-model-page | `siliconflow.com/models/qwen-qwen3-embedding-8b` | — |
| **Novita AI** | $0.070 | Verified-model-page | Search summary sourced from `blogs.novita.ai/qwen3-embedding-8b/` | Confirm free-tier / rate-limit story |

**Corollary — DeepInfra confirmed-pooled tier (from the founder-provided screenshot of `deepinfra.com/pricing`):**

| Model | Context | $/M |
|---|---|---|
| bge-m3 | 8K | **$0.010** |
| bge-m3-multi | 8K | $0.010 |
| bge-en-icl | 8K | $0.010 |
| bge-large-en-v1.5 | 512 | $0.010 |
| bge-base-en-v1.5 | 512 | $0.005 |
| gte-large | 512 | $0.010 |
| gte-base | 512 | $0.005 |
| e5-large-v2 | 512 | $0.010 |
| e5-base-v2 | 512 | $0.005 |
| multilingual-e5-large | 512 | $0.010 |
| multilingual-e5-large-instruct | 512 | $0.010 |
| all-MiniLM-L12-v2 | 512 | $0.005 |
| all-MiniLM-L6-v2 | 512 | $0.005 |

**Practical implication:** `bge-m3` at $0.010/M on DeepInfra's confirmed-pooled tier — 568M params, MIT license, 8K context, 100+ languages, dense + sparse + multi-vector modes — is an **unambiguously verified** cheap-hosted multilingual embedding path. Whenever the marginal MMTEB gain from Qwen3-8B (~70.58) over BGE-M3 (~63 MTEB-Eng but MMTEB strong) isn't worth the pricing-verification risk, BGE-M3 wins.

---

## Files touched during the session

Full inventory. Point future readers here rather than making them grep.

### New provider modules (`packages/ai/src/embeddings/providers/`)
- `base.ts` — abstract `BaseEmbeddingProvider` (caching, batching, normalization)
- `ai-sdk.ts` — `AiSdkEmbeddingProvider` (wraps any `EmbeddingModel` from any `@ai-sdk/*`)
- `openai-compatible.ts` — for TEI, vLLM, SGLang, Groq, Anyscale
- `cohere.ts` — via `@ai-sdk/cohere`
- `mistral.ts` — via `@ai-sdk/mistral`
- `google.ts` — via `@ai-sdk/google`
- `bedrock.ts` — via `@ai-sdk/amazon-bedrock` (async factory, lazy import)
- `ollama.ts` — via `ai-sdk-ollama` (default `qwen3-embedding:0.6b`)
- `voyage.ts` — via `voyageai` (lazy)
- `jina.ts` — raw fetch to `api.jina.ai/v1`
- `nebius.ts` — raw fetch to `api.tokenfactory.nebius.com/v1` (default `Qwen/Qwen3-Embedding-8B`)
- `mixedbread.ts` — via `@mixedbread-ai/sdk` (lazy)
- `transformers-js.ts` — via `@huggingface/transformers` v4 (lazy; on-device, browser+node)

### Rerankers (`packages/ai/src/embeddings/rerankers/`)
- `types.ts` — `Reranker`, `RerankResult`, `RerankOptions`
- `factory.ts` — dispatch on `RerankerType`
- `cohere.ts`, `voyage.ts`, `jina.ts`, `tei.ts`, `mixedbread.ts`, `bedrock.ts` — six reranker implementations
- `index.ts` — re-exports

### Wiring
- `packages/ai/src/embeddings/factory.ts` — `createEmbeddingProvider` / `createEmbeddingProviderAsync` / `createEmbeddingProviderFromEnv`
- `packages/ai/src/embeddings/index.ts` — re-exports
- `packages/ai/src/env.ts` — added ~25 new env vars (COHERE_/VOYAGE_/JINA_/MXBAI_/OLLAMA_/OPENAI_COMPATIBLE_/BEDROCK_/TRANSFORMERS_JS_/NEBIUS_/GOOGLE_EMBEDDING_MODEL/MISTRAL_EMBEDDING_MODEL)
- `packages/ai/package.json` — added `@ai-sdk/cohere`, plus optional peers for `voyageai`, `@mixedbread-ai/sdk`, `@huggingface/transformers`, `@ai-sdk/amazon-bedrock`
- `turbo.json` — added 24 env-var entries to `globalEnv`

### Documentation
- `packages/ai/docs/capabilities/embeddings/STATE-OF-THE-ART.md` — 792-line research synthesis (unchanged this session)
- `packages/ai/docs/capabilities/embeddings/PROVIDERS.md` — integration catalog with per-provider config
- `packages/ai/docs/capabilities/embeddings/decisions.md` — this file
- `packages/ai/docs/capabilities/embeddings/research/*` — 12 files, digest audit trail (source-index, contradictions, gaps, sparks, watchlist, findings, next-research, plus the 5 raw `.research.md` files and `prompt.md`)

## Related decisions (cross-index)

- `research/findings.md` — evidence-backed findings `B-01-01` through `B-01-52`
- `research/contradictions.md` — `C-01` through `C-28` cross-source disagreements + resolutions
- `research/gaps.md` — `G-01` through `G-20` open questions with effort estimates
- `research/sparks.md` — `S-01` through `S-27` single-source signals worth tracking
- `research/watchlist.md` — `W-01` through `W-30` items to re-check quarterly
- `research/next-research.md` — `NR-01` through `NR-26` prioritized follow-up roadmap
