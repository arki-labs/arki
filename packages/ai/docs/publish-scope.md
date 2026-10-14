# @arki/ai publish scope

Goal: a small hard-dependency set. Everything heavy is an optional peer behind an explicit entry.

- Hard deps before W1-12: **28**
- Hard deps after this change: **16**
- Target: **<= 12** (reached when the "step 2" items below land: 16 - 6 = 10)

## Dependency table

| dep | today | target | entry | reason |
| --- | --- | --- | --- | --- |
| `@ai-sdk/ui-utils` | removed | remove | - | No import anywhere in `src` or any `exports` target. |
| `csv-parse` | removed | remove | - | No import. |
| `@t3-oss/env-core` | removed | remove | - | No direct import; env goes through `@arki/env`. |
| `vitest` | devDependency | dev | - | Test runner only; was in runtime deps. |
| `@ai-sdk/provider` | devDependency | dev | - | Only types used in tests. |
| `@ai-sdk/react` | optional peer | optional peer | `./react` | Only `react/hooks/useAIChat.tsx`. |
| `react-markdown`, `remark-gfm`, `streamdown` | optional peer | optional peer | `./react/md` | Only `react/md.tsx` (moved from `./md` so it is a React adapter entry, which `arki-layers` L003 requires). |
| `@ai-sdk/amazon-bedrock` | hard | optional peer | `./embeddings/bedrock` | Static import in the root embeddings factory. Needs lazy load. |
| `@ai-sdk/cohere` | hard | optional peer | `./embeddings/cohere` | Same: root factory imports it. |
| `@ai-sdk/google` | hard | optional peer | `./google` | Root `provider-router` and `createLLMProvider` import it. |
| `@ai-sdk/groq` | hard | optional peer | `./groq` | Same. |
| `@ai-sdk/mistral` | hard | optional peer | `./mistral` | Same. |
| `@qdrant/js-client-rest` | hard | optional peer | `./vector-search/qdrant` | Root exports `QdrantVectorProvider`. |
| `ai`, `ai-sdk-ollama`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/otel` | hard | hard | root | Core: local-first default (Ollama), OpenAI-compatible path, telemetry. |
| `@arki/contracts`, `@arki/env`, `@arki/log`, `zod` | hard | hard | root | Core. |
| `@arki/async` | hard | hard (open) | `./orchestration` | Founder question: fold into `ai` or publish alone. Not decided here. |
| `@mastra/core` | optional peer, pinned `1.37.1` | optional peer, range | `./mastra` | See follow-up. |

Target hard set (10): `ai`, `ai-sdk-ollama`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/otel`, `@arki/async`, `@arki/contracts`, `@arki/env`, `@arki/log`, `zod`.

## Done in W1-12

- Removed 3 dead deps. Moved `vitest` and `@ai-sdk/provider` to dev. Declared `@types/node` and `"types": ["node"]` (TS no longer picks node types up implicitly).
- Moved 4 subpath-only deps (`@ai-sdk/react`, `react-markdown`, `remark-gfm`, `streamdown`) to optional peers (also dev deps for typecheck). `./md` is now `./react/md`.
- Deleted three pure re-export shims (`./google-genai`, `./ollama`, `./openrouter`) and their deps.
- Callers that import those subpaths now declare the peers: `apps/ekuation/start`, `apps/hyphenate/start` (peers), `apps/everseek/backend`, `apps/hyphenate/backend` (SDKs now direct deps).
- `LLM_PROVIDER` now includes `ollama` and defaults to it. No paid default.
- `SecureConfig` no longer has a built-in key. It throws without `encryptionKey` or `ENCRYPTION_KEY`. The shared instance is now `getSecureConfig()` (lazy).

## Remaining steps

1. Replace the `./*` catch-all export with explicit entries. Keep the root server-safe.
2. Make the six hard provider deps above optional peers:
   - Load Google, Groq, Mistral, Cohere, Bedrock and Qdrant lazily (dynamic `import()` with a clear "install X" error) in `provider-router`, `createLLMProvider`, `embeddings/factory`, and `vector-search/factory`.
   - Or move them to explicit entries. Either way the root must stop importing them statically. Many apps import these from the root, so this is a breaking change; ship as a minor (0.x).
3. Replace `*` ranges on `@huggingface/transformers`, `@mixedbread-ai/sdk`, `voyageai` with real ranges.
4. Decide `@arki/async` (founder).

## Follow-up: `@mastra/core`

Peer is pinned to exactly `1.37.1`. npm latest is `1.77.0`. Not bumped here. Risk: 40 minor versions of drift; `src/mastra.ts` and `mastra.test.ts` use runtime and stream-part types that may have changed. Plan: loosen to a range, run `mastra.test.ts` against current, then release.
