---
"@arki/cli": patch
---

Stop publishing type-test files (`src/**/*.test-d.ts`). The `!src/**/*.test.*` exclude does not match them, because the name is `.test-d.ts`, not `.test.ts`.

No docs impact: only the published file list changed. No demo impact: no runtime file changed.
