---
"@arki/cli": patch
---

Stop publishing type-test files (`src/**/*.test-d.ts`). The `!src/**/*.test.*` exclude does not match them, because the name is `.test-d.ts`, not `.test.ts`.

no docs impact: only the published file list in package.json changed.
no demo impact: no runtime file changed, only what the package ships.
