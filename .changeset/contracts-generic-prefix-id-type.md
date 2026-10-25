---
'@arki/contracts': patch
---

`defineId(prefix)` with a generic prefix now publishes its id type as `${P}${string}`. Before, a package that built ids from a caller's type parameter (`createTombstoneTable<TPrefix>` in `@arki/ai`) emitted Zod's template-literal inference into its `.d.ts`, which tsc printed as `[TPrefix] extends $ZodTemplateLiteralPart[] ? never : never`. Apps reading the published types saw those ids as `never`, and the declaration exposed Zod internals (`TYPES_E001`). Ids with a literal prefix and branded ids (`{ kind }`) are unchanged.

Test: `src/ids.emitted.test.ts` builds the contracts declarations, a producer with a generic prefix, and a consumer that reads only declarations.

no docs impact: the public types already documented `${P}${string}`; only the emitted text changes.
no demo impact: no demo builds ids from a generic prefix.
