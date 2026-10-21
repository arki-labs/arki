---
'@arki/ai': minor
---

`@arki/ai` closes the gaps the demos found. All additions; existing calls keep their types and answers.

- **Usage in results.** `createLLMProvider()` now returns `LLMProviderWithUsage`, a `StructuredLLMProvider` that also names its `provider` and `model` and has `generateStructuredResult` and `generateTextResult`. They make the same calls and return `{ value, usage: { inputTokens, outputTokens }, provider, model }`.
- **Spans without OTLP.** Generation calls report `gen_ai` spans whenever an OpenTelemetry tracer provider is registered, not only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. `AI_TELEMETRY=off` turns them off.
- **Provider probe.** `probeLLMProvider()` checks the provider `createLLMProvider` would use: Ollama answers and has the model, an OpenAI-compatible `baseURL` answers, or a cloud key is set. It returns the new `ProviderUnavailable` failure (`ai.provider_unavailable`, data `{ provider, model, problem }`) instead of throwing. `LLM_PROVIDERS` and `resolveLlmProvider` are exported too.
- **Local pricing.** `priceOf({ provider, model, inputTokens, outputTokens })` returns `{ usd, basis }`: a local provider (`ollama`) costs 0 with `basis: 'local'`; an unknown hosted model keeps the default rate with `basis: 'default-rate'`. `calculateLLMCost` takes an optional `{ provider }` and returns 0 for a local one; without it the answer is unchanged.
- **Fake provider.** `@arki/ai/testing` exports `createFakeLLMProvider`: scripted answers and usage, no HTTP, with the real schema check.
- **Dot plugin.** `llm(...)` from `@arki/ai/dot` publishes the provider as `llm`. `dot explain` lists it; by default it probes at boot, so an unusable provider fails boot with `ProviderUnavailable` and `dot doctor` marks the plugin failed. `probe: false` boots without a model; `instance` injects a provider such as the fake.

Demo impact (the demos are not changed now; these workarounds become redundant when they adopt this release):

- `drop-studio` lib-gaps #22: `backend/src/ai/telemetry.ts` (its own `registerTelemetry` integration) — read `usage` from `generateStructuredResult`, and the `gen_ai` spans now reach its X-ray tracer provider without it. Because the demo registers a tracer provider, its X-ray rail will also show `@arki/ai`'s `gen_ai` spans, prompts and completions included; set `AI_TELEMETRY=off` to keep today's view.
- `drop-studio` #23 and `faultline` #7: `backend/src/ai/probe.ts` — `probeLLMProvider`.
- `drop-studio` #24: `costOf` in `backend/src/ai/telemetry.ts` — `priceOf`.
- `drop-studio` #27: `backend/src/ai/fake-ollama.ts` — `createFakeLLMProvider` for in-process tests. The e2e runs, where the backend is a separate process, still need the fake HTTP server.
- `drop-studio` #28: no `llm` plugin — `llm(...)`.
- `faultline` imports `@arki/ai` and registers an X-ray tracer provider too, so the same `gen_ai` spans appear in its rail.
