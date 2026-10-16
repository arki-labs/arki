---
'@arki/dot': patch
---

The app builder's list checks (`.features()`, `.useAll()`, `.infra()`, `.entrypoints()`) walk the list by index instead of re-slicing it at every step, which made type-checking quadratic in the number of units. Mounting 100 chained features costs 0.94M type instantiations instead of 2.65M; 200 features type-check instead of hitting the compiler's limit. A list longer than 1024 units is refused with a `DOT:` label. New `src/tests/typecheck-budget.test.ts` keeps the ceilings (400k at 50 features, 1.1M at 100).
