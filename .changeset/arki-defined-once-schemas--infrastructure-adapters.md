---
'@arki/db': minor
---

Repair schema/type agreement across Drizzle validators, ID factories and AI configuration.

Breaking: generated table validators no longer claim phantom `$type<T>` shapes. Use a runtime schema with `jsonColumn` and reuse it in explicit validator refinements for precise input/output types. Bare JSON columns retain the native runtime validator and its honest inferred type.

Breaking: `createIdFactory(prefix)` infers its ID from the literal prefix; remove the former second type argument. Payments ID aliases now reflect the prefixes their generators already produce. Existing generated values and stored IDs are unchanged.

Breaking: replace AI `SearchOptionsType` with `SearchSettings`, and `AIServiceConfigType` with `RAGServiceConfig`. The `@arki/ai/types` aliases use those same distinct names. Provider configuration and sanitizer patterns now share their actual validation schemas, preserving custom `RegExp` rules.

See `docs/features/arki-framework/migrations/defined-once.md` for migration examples and compatibility notes.
