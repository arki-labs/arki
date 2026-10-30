---
"@arki/contracts": patch
---

`defineId` now returns named types: `IdDeclaration<P>`, and the new `BrandedIdDeclaration<P, Kind>` for an id with a `kind`. A package that exports an id now prints this name in its `.d.ts` instead of the whole object with its Zod schema type. The `schema` type and every inferred id type are unchanged.

No demo impact: no call site changes.
