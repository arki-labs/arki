---
'@arki/ai': minor
---

The root entry is portable, every import path is an explicit entry, and the tombstone table takes any Standard Schema for its user id.

Breaking:

- The root `@arki/ai` no longer exports `selectPodHopMoments`, `HopSelection` or `HopTranscript`. Import them from `@arki/ai/capabilities/podhop`, a Node-only entry (it runs the macOS `say` command through `node:child_process`).
- The `./*` and `./react/*` wildcard exports are gone. Only the paths in `package.json` `exports` resolve: `.`, `./react`, `./react/index`, `./react/md`, `./cost`, `./safety`, `./dot`, `./testing`, `./drizzle`, `./drizzle/sqlite`, `./env`, `./sdk`, `./anthropic`, `./google`, `./groq`, `./mistral`, `./openai`, `./mastra`, `./transcription`, `./validation`, `./runtime/index`, `./ai-service/types`, `./ai-service/structured-generation`, `./capabilities/ask`, `./capabilities/episode-analysis`, `./capabilities/pips`, `./capabilities/queue`, `./capabilities/podhop`. Any other deep path (for example `@arki/ai/debug`, `@arki/ai/errors`, `@arki/ai/vector-search/...`) no longer resolves; import the same names from the root.
- `createTombstoneTable` (`./drizzle`, `./drizzle/sqlite`) takes `userId: { schema: StandardSchemaV1<unknown, TUserId> }` instead of a Zod type. A `defineId(...)` declaration still works unchanged; a Valibot or ArkType schema now works too. `TUserId` is still inferred, so callers write no type arguments.

Other changes:

- The Qdrant provider derives point ids with WebCrypto (`crypto.subtle.digest('SHA-1', ...)`) instead of `node:crypto`. The ids are byte-identical, so stored points keep their ids (a golden test locks them).
- A test bundles the root entry for the browser and fails if any file it reaches imports a Node built-in.

docs: README `Public imports` lists every entry; `llms.txt` regenerated.
no demo impact: no demo imports podhop, a removed deep path, or `createTombstoneTable`.
