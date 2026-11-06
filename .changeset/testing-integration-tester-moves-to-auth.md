---
"@arki/testing": minor
---

`IntegrationTester`, `initTester` and their types moved to `@arki/auth`. The entries `@arki/testing/server/integration-tester` and `@arki/testing/server/tester-builder` are gone: import every name from `@arki/auth/testing/integration-tester` instead. The names and types are unchanged, so only the import path changes. `@arki/testing` no longer depends on `@arki/auth` in any form (it was a dev dependency and an optional peer), which breaks the package cycle `@arki/testing -> @arki/auth -> @arki/mail -> @arki/journal -> @arki/admin -> @arki/testing`. `@arki/db` and `@arki/kv` are no longer dependencies; only the moved code used them.

Docs: README `## Public imports`, `docs/agent-guide.md`; the integration tester guide moved to `@arki/auth` (`docs/integration-tester.md`).
