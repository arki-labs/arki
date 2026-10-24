AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/ai

## Laws

1. Local models come first. With `LLM_PROVIDER` unset, the provider is Ollama. A cloud provider (OpenAI, Anthropic, Groq, Google, Mistral) needs an explicit signal: `LLM_PROVIDER` or a key. A key never overrides an Ollama signal. The auto-detect order is `ollama -> openai -> anthropic`.
2. Never ship a stub as a runtime choice. No `'stub'` provider name. A missing key or an unreachable Ollama throws a `ConfigurationError` that names the fix. Test doubles are fine at the test boundary (`vi.mock`, an injected adapter).
3. Cost telemetry names the resolved model. Never log a dollar value from a hardcoded model name. Log the model that served the call, or add `costEstimateBasis` next to the number.
4. This package does not make vectors. Text to vectors is `@arki/embeddings`. The core takes the env map as an argument and never reads `process.env`. Only `@arki/ai/dot` passes `process.env`.
5. Apps never set their own embedding model or dimensions. The `EmbeddingSpace` (`embedder.space`) carries them, and `createVectorIndex` sizes the collection from it.
6. `runVectorReconciliation` acknowledges a tombstone only against a durable index (`VectorIndex.durable`). It re-checks every upserted batch with `stillCurrent(ids)`, so a point deleted during an upsert ends up deleted. `@arki/ai/drizzle` owns the tombstone table and outbox.
7. Expected refusals are returned, never thrown: `RateLimited`, `BudgetExceeded`, and failures a tool returns. A provider that is down still throws.
8. A tool result is checked against its `output` schema before the model sees it. A mismatch is a `ToolOutputError`.
9. Feature code sees an adapter (`ctx.llm`), never `new OpenAIService(...)`. Defaults per capability live in the adapter file.
10. `createFlow` runs in memory. Work that must survive a restart belongs in an `@arki/journal` workflow.
11. The package is not cross-runtime yet: Qdrant imports `node:crypto`. Do not promise browser or Hermes support for the server entries.

## Changing this package

- New provider service: `src/ai-service/<name>-service.ts`. Match `OllamaService`'s `generateStructured*` signatures, add the name to `LLMProviderConfig` in `src/ai-service/factory.ts` and to the model defaults there.
- New embedding provider: not here. Add it to `@arki/embeddings`.
- New failure: `src/failures.ts`, with JSDoc `@fix` and `@verify`.
- New error class: `src/errors.ts`, with JSDoc `@fix` and `@verify`.
- A new export needs an entry in `package.json` `exports` and a line in `src/index.ts` when it belongs to the root.
- Run `bun ../../tooling/library/src/llms.ts --write` after an export change.
- Keep `README.md`, `llms.txt`, `docs/agent-guide.md` and `docs/recipes/set-up-ai.md` in step.
- `docs/publish-scope.md` is internal: it is not in the `files` list. Do not link it from shipped docs. The research notes (capabilities, tech radar, UI research, adapter-layer proposal) live in `docs/arki/research/ai/`.
- The package will be split into seven packages in later minor releases (`docs/arki/research/12-ai-split/naming.md`). Do not start the split inside an unrelated change.

## Verify

```sh
bun run test
bun run typecheck
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
