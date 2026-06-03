# @arki/ai — Laws

Canonical rules for code that uses `@arki/ai` and for any feature that
adds AI capability to an Arki app. These rules apply at design time, at
review time, and at runtime.

## LAW 1 — Local LLMs take priority over cloud LLMs

When a feature needs an LLM, the default backend is a **locally-running
model** (Ollama, llama.cpp, or any OpenAI-compatible local endpoint).
Cloud providers (OpenAI, Anthropic) are explicit fall-throughs, never
implicit defaults.

### Why

- **No egress.** Prompts and outputs never leave the operator's machine
  unless they explicitly opt in to a cloud provider.
- **No cost.** A local run costs $0; a cloud run costs real money. For
  development, debugging, soak-testing, and demos, that's the right
  default.
- **No rate limits.** Cloud APIs rate-limit per minute / per day; local
  models are bounded only by hardware.
- **No vendor lock-in by accident.** Code that defaults to a cloud
  provider quietly couples the feature to that vendor's quirks
  (response formatting, system-prompt behaviour, tool schemas).
  Defaulting to local keeps the abstraction honest.

### How to apply

1. **Provider auto-detect order is fixed: `ollama → openai → anthropic`.**
   When `LLM_PROVIDER` is unset, the resolver picks the first signal
   present in env. Ollama is signaled by `OLLAMA_BASE_URL` or
   `OLLAMA_HOST` being set, OR — at the resolver's discretion — by
   `localhost:11434` reachability.

2. **Cloud providers require explicit signal.** `OPENAI_API_KEY` /
   `ANTHROPIC_API_KEY` activate their respective branches, but never
   override an Ollama signal. To force a cloud provider, set
   `LLM_PROVIDER=openai` or `LLM_PROVIDER=anthropic` explicitly.

3. **Defaults per capability live in the adapter.** Text-only agents
   default to a small model (e.g., `llama3.2:3b` on Ollama,
   `gpt-4o-mini` on OpenAI). Vision agents default to a multimodal
   model (e.g., `llama3.2-vision:11b` on Ollama, `gpt-4o` on OpenAI).
   Per-feature overrides go through `CreateLlmAdapterOptions.model`.

4. **The Ollama path uses the native `ollama` client through `OllamaService`.**
   `OllamaService` from `@arki/ai` wraps the `ollama` package's chat
   endpoint and uses Ollama's **native `format` parameter** with a
   JSON-Schema (derived from the Zod schema via `z.toJSONSchema(...)`) for
   token-level constrained decoding — outputs are guaranteed to match the
   schema. Multimodal calls round-trip through Ollama vision models
   (llama3.2-vision, llava) via the AI SDK's `{ type: 'image', image: <url
   | Uint8Array | base64> }` message-part shape; the service downloads and
   base64-encodes URL-form images for you.

   *Why native, not the OpenAI-compat shim?* `chat({ format: jsonSchema })`
   does grammar-constrained sampling at the token level. Going through
   `@ai-sdk/openai`-against-`/v1` strips the `format` field and falls back
   to prompt-engineered JSON, which fails much more often on small local
   models.

5. **Documentation says local first.** Every README / setup guide for an
   AI-using feature must list Ollama as the default and cloud providers
   as alternatives. Never invert this order.

### Where this rule lives in code

- `packages/ai/src/ai-service/ollama-service.ts` — `OllamaService`, the
  canonical local-LLM primitive. Mirrors `OpenAIService` /
  `AnthropicService` for the `generateStructured*` methods, so any caller
  typed against those signatures is provider-agnostic.

- `apps/games-platform/backend/src/features/historical-assets/content-discovery/llm-adapter.ts`
  — the canonical *consumer*: `DiscoveryLlmAdapter` interface, default
  models per capability, `resolveLlmProvider` auto-detect, and the
  `createLlmAdapter` factory that returns `OllamaService` /
  `OpenAIService` / `AnthropicService` based on the precedence rules
  above.

## LAW 2 — Never stub LLM calls in production code paths

Stubs / canned responses MUST NOT be a runtime-selectable backend.

### Why

- **Silent failure.** A misconfigured deploy that silently selects a
  stub will produce confident-looking fake data. Failing loudly when no
  real provider is available is strictly better.
- **No legitimate "free option."** With LAW 1 in place, Ollama already
  covers the "I don't want to pay for a cloud LLM" use case with real
  intelligence. Stubs add no value at runtime.

### How to apply

1. **No `'stub'` value in any `LlmProviderName` union.** If you find
   one, delete it.
2. **Test mocks are different and allowed.** `vi.mock('@arki/ai')` and
   per-test injected adapter objects are valid — they substitute at the
   test boundary, not in production. The line is: anything reachable by
   a runtime env var or config value MUST be a real provider.
3. **A missing API key / unreachable Ollama daemon should throw.**
   `resolveLlmProvider` throws with a message that points the operator
   at the canonical setup steps. It never falls back to fabricated
   output.

### Failure modes this prevents

- "Why is the discovery pipeline producing the same canned candidates
  every run?" — because someone shipped with `LLM_PROVIDER=stub` set in
  prod env.
- "Why are eval scores suspiciously consistent?" — because the agent
  was hitting a stub during nightly evals.
- "Why didn't CI catch this prompt regression?" — because CI was using
  a stub instead of a real (or recorded) model call.

## LAW 3 — Cost telemetry reflects the resolved provider, never a hardcoded model

A consumer that hardcodes a model name for cost accounting will misreport spend
whenever LAW 1 resolves a different provider.

### Why

- **Over-reporting.** `createLlmProvider()` auto-selects provider/model from env per
  LAW 1. A consumer that hardcodes `const COST_MODEL = 'gpt-4o-mini'` and passes it to
  `calculateLLMCost(COST_MODEL, …)` over-reports cost whenever Ollama is the resolved
  provider — Ollama spend is $0, but the telemetry bills it at the OpenAI rate.
- **Silent drift.** The dollar figure looks authoritative while being wrong; operators
  make capacity and pricing decisions off a number that tracks a constant, not reality.

### How to apply

Never log a single dollar value without disclosing one of these two bases:

1. **Resolved-model log** — log the actual provider/model returned by the call (when the
   provider surface exposes it). The dollar figure then matches what was actually spent.
2. **Estimate-basis disclaimer** — log a `costEstimateBasis: '<rate-source>'` field next
   to the dollar figure so operators read it as a ceiling (e.g. "what we would have paid
   on OpenAI's gpt-4o-mini rate"), not as actual spend.

### Failure modes this prevents

- "Why does our AI cost dashboard show $40/day when the bill is $3?" — because every
  generation logged a hardcoded `gpt-4o-mini` rate while Ollama served the requests.
- "Which of these cost numbers is real spend vs an estimate?" — answered by the presence
  of `costEstimateBasis`; its absence implies a resolved-model log.

## How to extend

When adding a new AI-powered feature to Arki:

1. Define an adapter interface that hides the provider choice from the
   feature code. Agents see `ctx.llm`, never `new OpenAIService(...)`.
2. Wire `createLlmAdapter` (or a feature-local equivalent that follows
   the same precedence rules) at the context-factory level.
3. Default to Ollama; add cloud providers as fall-throughs.
4. Document per-capability default models in the adapter file, not in
   ad-hoc constants scattered through agents.
5. Add the model setup steps to the feature's README — Ollama first
   (`ollama pull llama3.2-vision:11b`), then API-key paths.
