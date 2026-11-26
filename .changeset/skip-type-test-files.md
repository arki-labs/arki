---
"@arki/cli": patch
"@arki/dot": patch
"@arki/failure": patch
"@arki/journal": patch
"@arki/lock": patch
"@arki/mail": patch
"@arki/mcp": patch
"@arki/pubsub": patch
"@arki/queue": patch
"@arki/resilience": patch
"@arki/schedule": patch
"@arki/schema": patch
"@arki/testing": patch
"@arki/ts": patch
---

Stop publishing type-test files (`src/**/*.test-d.ts`). The `!src/**/*.test.*` exclude does not match them, because the name is `.test-d.ts`, not `.test.ts`.
