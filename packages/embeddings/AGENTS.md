AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/embeddings

## Laws

1. An expected refusal is a returned failure, never a throw. Throw only for a bug in the caller's own code (a custom `embed` or `onProgress` that throws is rethrown).
2. Every provider answer goes through the output check in `src/embedder.ts` (count, dimensions, finite numbers, non-zero norm). A model record's `embedTexts` returns raw vectors and never validates them itself.
3. `embedMany` is all or nothing. Never return partial vectors from a failed batch.
4. The root imports no provider SDK, no `process.env` and no `node:*`. A provider SDK is an optional peer, loaded on the first call, and a missing one is `ModelUnavailable { reason: 'peer-missing' }`.
5. The package reads no environment variables and creating a model never touches the network. Apps pass keys and URLs to `createXModel`. A revision the provider reports later (Ollama's digest) is read on the first call.
6. Vectors from different spaces are never mixed. `EmbeddingSpace` holds everything that must match; a change to a prompt changes `instructionVersion`, so it is a new space.
7. The library never changes input text. Normalising is the caller's job, and the cache key must hash the exact text sent.
8. A new failure is defined once in `src/failures.ts` with `defineFailure`, with JSDoc `@fix` and `@verify`, and listed in `EMBED_FAILURES`.
9. Types are written once. A model record's facts live in `EmbeddingModel`; do not restate them in an adapter.
10. `fakeEmbedder` is not semantic. Never assert ranking by meaning against it.
11. Every public options object has a Standard Schema (`embedOptionsSchema`, `cohereRerankerOptionsSchema`, and so on). A factory returns `ConfigurationFailure` on bad options; a per-call option throws through `assert`. Read one as JSON Schema with `schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })`.

## Changing this package

- New provider: `src/<name>/index.ts` returning an `EmbeddingModel`, an `exports` entry in `package.json`, a branch in `src/resolve.ts`, and a fetch-stub test. Add it to `scripts/smoke.mjs` if it runs without a peer.
- New failure: `src/failures.ts`, then update the README Failure behaviour table and the guide's Errors section.
- Run `bun ../../tooling/library/src/llms.ts --write` after an export change.
- Keep `README.md`, `llms.txt` and `docs/agent-guide.md` in step. README examples come from `examples/*.ts` through `from=` fences.
- The package ships `dist/`, `src/` (without tests), `docs/` and `llms.txt`. `bench/` and `scripts/` do not ship.

## Verify

```sh
bun run test
bun run typecheck
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```

Then ask the running app what this package added. Run both from the app root.

```sh
dot explain --json | jq '.data'
dot doctor --json | jq '.data'
```

- `dot explain --json` shows the `embeddings` unit and the `embedder` it provides.
- `dot doctor --json` shows whether the app boots with the `embeddings` unit, and lists any issue. A model that did not build does not stop the boot: `embedder` is `null`, and the log has the warning `embeddings are off, embedder is null`.
