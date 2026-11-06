---
"@arki/ai": minor
---

Import `searchResultSchema` and `generationResultSchema` from `@arki/ai/zod`; they moved there from `@arki/ai/react`, whose `SearchResult` and `GenerationResult` stay plain TS types. `./react`, `./dot` and `./runtime/index` no longer name Zod types in their `.d.ts`.
