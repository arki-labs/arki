---
'@arki/ai': patch
'@arki/db': patch
'@arki/dot': patch
'@arki/failure': patch
'@arki/http': patch
'@arki/journal': patch
'@arki/queue': patch
'@arki/schedule': patch
'@arki/schema': patch
'@arki/ts': patch
---

The build no longer compiles type tests (`*.test-d.ts`). They stay in `typecheck`, but a type test can no longer fail the build, and the published `dist` no longer holds compiled type tests.

`@arki/db` exports the `OnDelete` type from `@arki/db/id` and `@arki/db/sqlite`. A package whose types come from `idColumns` (such as `@arki/auth`) can now build its declarations. Before, TypeScript could not name `OnDelete` and stopped with TS2883.

`@arki/ai` drops a `@ts-expect-error` above the `@huggingface/transformers` import. That package is now always installed, so the comment had no error to hide and failed the build.
