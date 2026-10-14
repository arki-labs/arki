---
'@arki/ai': minor
---

Smaller install and safer defaults. Removed unused `@ai-sdk/ui-utils`, `csv-parse` and `@t3-oss/env-core`; `vitest` is now a dev dependency. `@ai-sdk/react`, `react-markdown`, `remark-gfm` and `streamdown` are now optional peers: install them if you use `@arki/ai/react` or `@arki/ai/react/md` (`./md` moved to `./react/md`). The re-export shims `@arki/ai/google-genai`, `/ollama` and `/openrouter` are removed; import `@google/genai`, `ollama` and `@openrouter/ai-sdk-provider` directly. `LLM_PROVIDER` now accepts `ollama` and defaults to it (was `openai`). `SecureConfig` has no built-in fallback key: it throws without `encryptionKey` or `ENCRYPTION_KEY`, and the shared instance is now `getSecureConfig()`.
